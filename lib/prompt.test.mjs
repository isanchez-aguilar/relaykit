import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirm } from './prompt.mjs';

test('confirmation requires yes and safely declines at EOF', async () => {
  for (const [answer, expected] of [['y\n', true], ['YES\n', true], ['\n', false], ['no\n', false], ['', false]]) {
    const input = new PassThrough(), output = new PassThrough();
    const result = confirm('Apply? ', { input, output });
    input.end(answer);
    assert.equal(await result, expected);
  }
});
