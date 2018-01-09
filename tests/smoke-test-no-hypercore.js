/* global it, describe */

const assert = require('assert')
const Automerge = require('automerge')

describe('smoke test, no hypercore', () => {
  // https://github.com/inkandswitch/hypermerge/wiki/Smoke-Test
  let alice1, bob1
  it('1. Both Alice and Bob start with the same blank canvas. ' +
     'Both are online.', () => {
    alice1 = Automerge.change(Automerge.init('alice'), doc => {
      doc.x0y0 = 'w'
      doc.x0y1 = 'w'
      doc.x1y0 = 'w'
      doc.x1y1 = 'w'
    })
    assert.deepEqual(alice1, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'w',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
    bob1 = Automerge.merge(Automerge.init('bob'), alice1)
    assert.deepEqual(bob1, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'w',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
  })

  let alice2, bob2
  it('2. Alice makes an edit', () => {
    alice2 = Automerge.change(alice1, doc => { doc.x0y0 = 'r' })
    assert.deepEqual(alice2, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
    bob2 = bob1
  })

  let alice2a, bob2a
  it(`2a. Alice's edit gets synced over to Bob's canvas`, () => {
    const aliceChanges2a = Automerge.getChanges(alice1, alice2)
    bob2a = Automerge.applyChanges(bob2, aliceChanges2a)
    alice2a = alice2
    assert.deepEqual(bob2a, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
    assert.deepEqual(bob2a._conflicts, {})
  })

  let alice3, bob3
  it('3. Bob makes an edit', () => {
    bob3 = Automerge.change(bob2a, doc => { doc.x1y1 = 'b' })
    alice3 = alice2a
    assert.deepEqual(bob3, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'b'
    })
  })

  let alice3a, bob3a
  it(`3a. Bob's edit gets synced to Alice's canvas`, () => {
    const bobChanges3a = Automerge.getChanges(bob2, bob3)
    alice3a = Automerge.applyChanges(alice3, bobChanges3a)
    bob3a = bob3
    assert.deepEqual(alice3a, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'b'
    })
    assert.deepEqual(alice3a._conflicts, {})
  })

  let alice4, bob4
  it('4. Alice and/or Bob go offline', () => {
    alice4 = alice3a
    bob4 = bob3a
  })

  let alice5, bob5
  it('5. Both Alice and Bob make edits while offline', () => {
    alice5 = Automerge.change(alice4, doc => {
      doc.x1y0 = 'g'
      doc.x1y1 = 'r'
    })
    bob5 = Automerge.change(bob4, doc => {
      doc.x1y0 = 'g'
      doc.x1y1 = 'w'
    })
    assert.deepEqual(alice5, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'g',
      x1y1: 'r'
    })
    assert.deepEqual(bob5, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'g',
      x1y1: 'w'
    })
  })

  let alice6, bob6
  it('6. Alice and Bob both go back online, and re-sync', () => {
    const aliceChanges6 = Automerge.getChanges(alice3, alice5)
    const bobChanges6 = Automerge.getChanges(bob3, bob5)
    alice6 = Automerge.applyChanges(alice5, bobChanges6)
    bob6 = Automerge.applyChanges(bob5, aliceChanges6)
    assert.deepEqual(alice6, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'g',
      x1y1: 'w'
    })
    assert.deepEqual(alice6._conflicts, {
      x1y0: {
        alice: 'g'
      },
      x1y1: {
        alice: 'r'
      }
    })
    assert.deepEqual(bob6, {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'g',
      x1y1: 'w'
    })
    assert.deepEqual(bob6._conflicts, {
      x1y0: {
        alice: 'g'
      },
      x1y1: {
        alice: 'r'
      }
    })
  })
})
