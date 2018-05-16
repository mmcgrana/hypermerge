const EventEmitter = require('events')
const Automerge = require('automerge')
const MultiCore = require('./MultiCore')
const discoverySwarm = require('discovery-swarm')
const swarmDefaults = require('datland-swarm-defaults')
const Debug = require('debug')

const log = Debug('hypermerge:index')

// The first block is used for metadata:
const START_BLOCK = 1
const METADATA = {
  hypermerge: 1
}

/**
 * An Automerge document.
 * @typedef {object} Document
 */

/**
 * Create and share Automerge documents using peer-to-peer networking.
 *
 * @param {Object} options
 * @param {string} options.path - path to directory used to store multiple
 *   hypercores
 * @param {number} [options.port=0] - port number to listen on
 */

module.exports = class Hypermerge extends EventEmitter {
  constructor ({path, port = 0, immutableApi = false, defaultMetadata}) {
    super()

    this.immutableApi = immutableApi
    this.defaultMetadata = defaultMetadata || {}
    this.port = port
    this.isReady = false
    this.feeds = {}
    this.docs = {}

    this.readyIndex = {} // docId -> Boolean
    this.groupIndex = {} // groupId -> [actorId]
    this.docIndex = {} // docId -> [actorId]
    this.metaIndex = {} // actorId -> metadata
    this.requestedBlocks = {} // docId -> actorId -> blockIndex (exclusive)

    this.core = new MultiCore(path)

    this.core.ready(this._onMultiCoreReady())
  }

  /**
   * Have any automerge documents been built?
   *
   * @param {filterCallback} [f] - a filter function
   * @returns {boolean}
   */
  any (f = () => true) {
    return Object.keys(this.docs).some(id => f(this.docs[id], id))
  }

  has (docId) {
    return !!this.docs[docId]
  }

  find (docId) {
    const doc = this.docs[docId]

    if (!doc) throw new Error(`Cannot find document. open(docId) first. docId: ${docId}`)

    return doc
  }

  set (doc) {
    const docId = this.getId(doc)
    log('set', docId)
    this.docs[docId] = doc
    return doc
  }

  /**
   * Opens an existing document.
   *
   * @param {string} docId - docId of document to open
   */
  open (docId, metadata = null) {
    this._ensureReady()
    log('open', docId)

    if (this.docs[docId]) return this.docs[docId]

    // we haven't seen this doc before:
    this.feed(docId)
  }

  /**
   * Creates an automerge document backed by a new hypercore.
   *
   * @param {object} metadata - metadata to be associated with this document
   */
  create (metadata = {}) {
    this._ensureReady()
    return this._create(metadata)
  }

  _create (metadata, parentMetadata = {}) {
    const feed = this.feed()
    const actorId = feed.key.toString('hex')
    log('_create', actorId)

    // TODO this is a little wacky:
    metadata = Object.assign(
      {},
      METADATA,
      { groupId: actorId }, // default to self if parent doesn't have groupId
      parentMetadata, // metadata of the parent feed to this feed (e.g. when opening, forking)
      this.defaultMetadata, // user-specified default metadata
      { docId: actorId }, // set the docId to this core's actorId by default
      metadata // directly provided metadata should override everything else
    )

    this._appendMetadata(actorId, metadata)

    const doc = this.set(this.empty(actorId))
    this._shareDoc(doc)

    return doc
  }

  change (doc, message = null, changeFn) {
    const docId = this.getId(doc)
    log('change', docId)
    return this.update(Automerge.change(doc, message, changeFn))
  }

  /**
   * Finds any new changes for the submitted doc for the actor,
   * and appends the changes to the actor's hypercore feed.
   *
   * @param {Object} doc - document to find changes for
   */
  update (doc) {
    this._ensureReady()

    const actorId = this.getActorId(doc)
    const docId = this.actorToId(actorId)
    const pDoc = this.find(docId)
    log('update', docId)

    // TODO: Should the changes ever be for anyone other than ourself?
    const changes = Automerge.getChanges(pDoc, doc)
      .filter(({actor}) => actor === actorId)

    this._addToMaxRequested(docId, actorId, changes.length)

    this._appendAll(actorId, changes)

    log('update.set', docId)
    return this.set(doc)
  }

  /**
   * Creates a new actor hypercore feed and automerge document, with
   * an empty change that depends on the document for another actor.
   *
   * @param {string} parentId - id of document to fork
   */
  fork (parentId) {
    this._ensureReady()
    log('fork', parentId)

    const parent = this.find(parentId)
    const doc = this._create({parentId}, this.metadata(parentId))

    return this.change(
      Automerge.merge(doc, parent),
      `Forked from ${parentId}`,
      () => {})
  }

  /**
   * Takes all the changes from a document (sourceId) and adds them to
   * another document (destId).
   * @param {string} destId - docId to merge changes into
   * @param {string} sourceId - docId to copy changes from
   */
  merge (destId, sourceId) {
    this._ensureReady()
    log('merge', destId, sourceId)

    const dest = this.find(destId)
    const source = this.find(sourceId)

    return this.change(
      Automerge.merge(dest, source),
      `Merged with ${sourceId}`,
      () => {})
  }

  /**
   * Removes hypercore feed for an actor and automerge doc.
   *
   * Leaves the network swarm. Doesn't remove files from disk.
   * @param {string} docId
   */
  delete (docId) {
    log('delete', docId)
    const doc = this.find(docId)
    this.core.archiver.remove(docId)
    delete this.feeds[docId]
    delete this.docs[docId]
    return doc
  }

  message (actorId, msg) {
    this.feed(actorId).peers.forEach(peer => {
      this._messagePeer(peer, msg)
    })
  }

  length (actorId) {
    return this._feed(actorId).length
  }

  /**
   * Is the hypercore writable?
   *
   * @param {string} actorId - actor id
   * @returns {boolean}
   */
  isWritable (actorId) {
    return this._feed(actorId).writable
  }

  isOpened (actorId) {
    return this._feed(actorId).opened
  }

  isMissingDeps (docId) {
    log('isMissingDeps', docId)
    const deps = Automerge.getMissingDeps(this.find(docId))
    return !!Object.keys(deps).length
  }

  empty (actorId) {
    return this.immutableApi
      ? Automerge.initImmutable(actorId)
      : Automerge.init(actorId)
  }

  metadatas (docId) {
    const actorIds = this.docIndex[docId] || []
    return actorIds.map(actorId => this.metadata(actorId))
  }

  metadata (actorId) {
    return this.metaIndex[actorId]
  }

  isDocId (actorId) {
    return this.actorToId(actorId) === actorId
  }

  getId (doc) {
    return this.actorToId(this.getActorId(doc))
  }

  actorToId (actorId) {
    const {docId} = this.metadata(actorId)
    return docId
  }

  getActorId (doc) {
    return doc._actorId
  }

  clock (doc) {
    return doc._state.getIn(['opSet', 'clock'])
  }

  _feed (actorId = null) {
    const key = actorId ? Buffer.from(actorId, 'hex') : null
    return this.core.createFeed(key)
  }

  feed (actorId = null) {
    this._ensureReady()

    if (actorId && this.feeds[actorId]) return this.feeds[actorId]

    return this._trackFeed(this._feed(actorId))
  }

  isDocReady (docId) {
    return this.readyIndex[docId]
  }

  replicate (opts) {
    return this.core.replicate(opts)
  }

  joinSwarm (opts = {}) {
    this._ensureReady()
    log('joinSwarm')

    const {archiver} = this.core

    const sw = this.swarm = discoverySwarm(swarmDefaults(Object.assign({
      port: this.port,
      hash: false,
      encrypt: true,
      stream: opts => this.replicate(opts)
    }, opts)))

    sw.join(archiver.changes.discoveryKey)

    Object.values(this.feeds).forEach(feed => {
      sw.join(feed.discoveryKey)
    })

    archiver.on('add', feed => {
      sw.join(feed.discoveryKey)
    })

    archiver.on('remove', feed => {
      sw.leave(feed.discoveryKey)
    })

    sw.listen(this.port)

    sw.once('error', err => {
      console.error('Swarm error:', err)
      log('joinSwarm.relisten')
      sw.listen()
    })

    return this
  }

  _appendMetadata (actorId, metadata) {
    if (this.length(actorId) > 0) throw new Error(`Metadata can only be set if feed is empty.`)

    this._setMetadata(actorId, metadata)

    return this._append(actorId, metadata)
  }

  _append (actorId, change) {
    log('_append', actorId)
    return this._appendAll(actorId, [change])
  }

  _appendAll (actorId, changes) {
    log('_appendAll', actorId)
    const blocks = changes.map(change => JSON.stringify(change))
    return _promise(cb => {
      this.feed(actorId).append(blocks, cb)
    })
  }

  _trackFeed (feed) {
    const actorId = feed.key.toString('hex')
    log('_trackFeed', actorId)

    this.feeds[actorId] = feed

    feed.ready(this._onFeedReady(actorId, feed))

    feed.on('peer-add', this._onPeerAdded(actorId))
    feed.on('peer-remove', this._onPeerRemoved(actorId))

    return feed
  }

  _onFeedReady (actorId, feed) {
    return () => {
      log('_onFeedReady', actorId)
      this._loadMetadata(actorId)
      .then(() => {
        const docId = this.actorToId(actorId)

        this._createDocIfMissing(docId, actorId)

        feed.on('download', this._onDownload(docId, actorId))

        return this._loadAllBlocks(actorId)
          .then(() => {
            if (actorId !== docId) return

            this.readyIndex[docId] = true
            this._emitReady(docId)
          })
      })

      /**
       * Emitted when a hypercore feed is ready.
       *
       * @event feed:ready
       * @param {object} feed - hypercore feed
       */
      this.emit('feed:ready', feed)
    }
  }

  _createDocIfMissing (docId, actorId) {
    if (this.docs[docId]) return

    // TODO extra, empty hypercores are still being created

    if (this.isWritable(actorId)) {
      this.docs[docId] = this.empty(actorId)
    }

    const parentMetadata = this.metadata(actorId)

    // TODO might need an empty commit to be included in other vector clocks:
    return this._create({docId}, parentMetadata)
  }

  _initFeeds (actorIds) {
    log('initFeeds')
    return Promise.all(
      actorIds.map(actorId => {
        // don't load metadata if the feed is empty:
        if (this.length(actorId) === 0) {
          log('_initFeeds.skipEmpty', actorId)
          return Promise.resolve(null)
        }

        return this._loadMetadata(actorId)
        .then(({docId}) => {
          if (this.isWritable(actorId)) {
            this.docs[docId] = this.empty(actorId)
          }
        })
        .then(() => actorId)
      }))
  }

  _loadMetadata (actorId) {
    if (this.metaIndex[actorId]) return Promise.resolve(this.metaIndex[actorId])

    return _promise(cb => {
      this._feed(actorId).get(0, cb)
    })
    .then(data => this._setMetadata(actorId, JSON.parse(data)))
  }

  _setMetadata (actorId, metadata) {
    if (this.metaIndex[actorId]) return this.metaIndex[actorId]

    this.metaIndex[actorId] = metadata
    const {docId, groupId} = metadata

    if (!this.groupIndex[groupId]) this.groupIndex[groupId] = []
    this.groupIndex[groupId].push(actorId)

    if (!this.docIndex[docId]) this.docIndex[docId] = []
    this.docIndex[docId].push(actorId)

    return metadata
  }

  _loadAllBlocks (actorId) {
    log('_loadAllBlocks', actorId)
    return this._loadOwnBlocks(actorId)
    .then(() => this._loadMissingBlocks(actorId))
  }

  _loadOwnBlocks (actorId) {
    log('_loadOwnBlocks', actorId)
    const docId = this.actorToId(actorId)

    return this._loadBlocks(docId, actorId, this.length(actorId))
  }

  _loadMissingBlocks (actorId) {
    const docId = this.actorToId(actorId)
    log('_loadMissingBlocks', actorId, docId)

    if (docId !== actorId) return

    const deps = Automerge.getMissingDeps(this.find(docId))
    log('_loadMissingBlocks.deps', deps)

    return Promise.all(Object.keys(deps).map(actor => {
      const last = deps[actor] + 1 // last is exclusive

      return this._loadBlocks(docId, actor, last)
    }))
  }

  _loadBlocks (docId, actorId, last) {
    log('_loadBlocks', docId, actorId, last)
    const first = this._maxRequested(docId, actorId, last)

    // Stop requesting if done:
    if (first >= last) return Promise.resolve()

    return this._getBlockRange(actorId, first, last)
    .then(blocks => this._applyBlocks(docId, blocks))
    .then(() => this._loadMissingBlocks(docId))
  }

  _getBlockRange (actorId, first, last) {
    log('_getBlockRange', actorId, first, last)
    const length = Math.max(0, last - first)

    return Promise.all(Array(length).fill().map((_, i) =>
      this._getBlock(actorId, first + i)))
  }

  _getBlock (actorId, index) {
    log('_getBlock', actorId, index)
    return _promise(cb => {
      this.feed(actorId).get(index, cb)
    })
  }

  _applyBlock (docId, block) {
    log('_applyBlock', docId)
    return this._applyBlocks(docId, [block])
  }

  _applyBlocks (docId, blocks) {
    log('_applyBlocks', docId)
    return this._applyChanges(docId, blocks.map(block => JSON.parse(block)))
  }

  _applyChanges (docId, changes) {
    log('_applyChanges', docId, changes)
    return changes.length > 0
      ? this._setRemote(Automerge.applyChanges(this.find(docId), changes))
      : this.find(docId)
  }

  // tracks which blocks have been requested for a given doc,
  // so we know not to request them again
  _maxRequested (docId, actorId, max) {
    if (!this.requestedBlocks[docId]) this.requestedBlocks[docId] = {}

    const current = this.requestedBlocks[docId][actorId] || START_BLOCK
    this.requestedBlocks[docId][actorId] = Math.max(max, current)
    return current
  }

  _addToMaxRequested (docId, actorId, x) {
    if (!this.requestedBlocks[docId]) this.requestedBlocks[docId] = {}
    this.requestedBlocks[docId][actorId] = (this.requestedBlocks[docId][actorId] || START_BLOCK) + x
  }

  _setRemote (doc) {
    const docId = this.getId(doc)
    log('_setRemote', docId)

    this.set(doc)

    if (this.readyIndex[docId]) {
      log('_setRemote.emit', docId)
      /**
       * Emitted when an updated document has been downloaded.
       *
       * @event document:updated
       * @param {string} docId - the hex id representing this document
       * @param {Document} doc - updated Automerge document
       */
      this.emit('document:updated', docId, doc)
    }
  }

  _shareDoc (doc) {
    const {groupId} = this.metadata(this.getActorId(doc))
    const keys = this.groupIndex[groupId]
    this.message(groupId, {type: 'FEEDS_SHARED', keys})
  }

  _relatedKeys (actorId) {
    const {groupId} = this.metadata(actorId)
    return this.groupIndex[groupId]
  }

  _messagePeer (peer, msg) {
    const data = Buffer.from(JSON.stringify(msg))
    peer.stream.extension('hypermerge', data)
  }

  _onMultiCoreReady () {
    return () => {
      log('_onMultiCoreReady')
      const actorIds =
        Object.values(this.core.archiver.feeds)
        .map(feed => feed.key.toString('hex'))

      this._initFeeds(actorIds)
      .then(() => {
        this.isReady = true
        actorIds.forEach(actorId => this.feed(actorId))
        this.emit('ready', this)
      })
    }
  }

  _onDownload (docId, actorId) {
    return (index, data) => {
      log('_onDownload', docId, actorId, index)
      this._applyBlock(docId, data)
      this._loadMissingBlocks(docId)
    }
  }

  _onPeerAdded (actorId) {
    return peer => {
      peer.stream.on('extension', this._onExtension(actorId, peer))

      this._loadMetadata(actorId)
      .then(() => {
        if (!this.isDocId(actorId)) return

        const keys = this._relatedKeys(actorId)
        this._messagePeer(peer, {type: 'FEEDS_SHARED', keys})

        this.emit('peer:joined', actorId, peer)
      })
    }
  }

  _onPeerRemoved (actorId) {
    return peer => {
      this._loadMetadata(actorId)
      .then(() => {
        if (!this.isDocId(actorId)) return

        this.emit('peer:left', actorId, peer)
      })
    }
  }

  _onExtension (actorId, peer) {
    return (name, data) => {
      switch (name) {
        case 'hypermerge':
          return this._onMessage(actorId, peer, data)
        default:
          this.emit('peer:extension', actorId, name, data, peer)
      }
    }
  }

  _onMessage (actorId, peer, data) {
    const msg = JSON.parse(data)

    switch (msg.type) {
      case 'FEEDS_SHARED':
        return msg.keys.map(actorId => this.feed(actorId))
      default:
        this.emit('peer:message', actorId, peer, msg)
    }
  }

  _emitReady (docId) {
    const doc = this.find(docId)
    log('_emitReady', docId)

    /**
     * Emitted when a document has been fully loaded.
     *
     * @event document:ready
     * @param {string} docId - the hex id representing this document
     * @param {Document} document - automerge document
     */
    this.emit('document:ready', docId, doc)
  }

  _ensureReady () {
    if (!this.isReady) throw new Error('Hypermerge is not ready yet. Use .once("ready") first.')
  }
}

function _promise (f) {
  return new Promise((resolve, reject) => {
    f((err, x) => {
      err ? reject(err) : resolve(x)
    })
  })
}
