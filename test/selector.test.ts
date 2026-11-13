import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toEnvironment } from '../src/kube.ts';
import { matches } from '../src/selector.ts';

describe('matches', () => {
  const labels = { trust: 'personal', 't3code.derfred.com/environment-set': 'bugzoo' };
  const cases: Array<[string, Parameters<typeof matches>[0], boolean]> = [
    ['an absent selector matches everything', undefined, true],
    ['{} matches everything', {}, true],
    ['matchLabels hit', { matchLabels: { trust: 'personal' } }, true],
    ['matchLabels miss', { matchLabels: { trust: 'client' } }, false],
    ['In', { matchExpressions: [{ key: 'trust', operator: 'In', values: ['client', 'personal'] }] }, true],
    ['NotIn on a set name', { matchExpressions: [{ key: 't3code.derfred.com/environment-set', operator: 'NotIn', values: ['bugzoo'] }] }, false],
    ['NotIn on an absent label', { matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['x'] }] }, true],
    ['Exists', { matchExpressions: [{ key: 'trust', operator: 'Exists' }] }, true],
    ['DoesNotExist', { matchExpressions: [{ key: 'trust', operator: 'DoesNotExist' }] }, false],
    ['all terms ANDed', { matchLabels: { trust: 'personal' }, matchExpressions: [{ key: 'tier', operator: 'Exists' }] }, false],
  ];
  for (const [name, selector, expected] of cases) {
    it(name, () => assert.equal(matches(selector, labels), expected));
  }
});

describe('toEnvironment', () => {
  it('reads ContainersReady, not Ready, which waits on the gate itself', () => {
    const pod = {
      metadata: { name: 't3code-bugzoo-0', uid: 'u' },
      status: {
        podIP: '10.0.0.7',
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'ContainersReady', status: 'True' },
          { type: 't3code.derfred.com/content-ready', status: 'False' },
        ],
      },
    };
    assert.deepEqual(toEnvironment(pod), { name: 't3code-bugzoo-0', uid: 'u', ip: '10.0.0.7', ready: true, contentReady: false });
  });

  it('treats a terminating pod as not ready, and a missing gate as unset', () => {
    const pod = { metadata: { name: 'p', uid: 'u', deletionTimestamp: 'now' }, status: { podIP: '10.0.0.8', conditions: [{ type: 'ContainersReady', status: 'True' }] } };
    assert.deepEqual(toEnvironment(pod), { name: 'p', uid: 'u', ip: '10.0.0.8', ready: false, contentReady: undefined });
  });

  it('treats a pod without an IP yet as not ready', () => {
    const pod = { metadata: { name: 'p', uid: 'u' }, status: { conditions: [{ type: 'ContainersReady', status: 'True' }] } };
    assert.equal(toEnvironment(pod).ready, false);
  });
});
