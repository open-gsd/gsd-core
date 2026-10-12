'use strict';

const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

/**
 * Replace child_process.spawn with a fake that records every call as
 * [cmd, argv, { ...opts, input }] in spawn order and answers once stdin ends.
 * `respond(call)` returns { stdout?, stderr?, status?, signal?, error? }. A signal
 * closes with a null status, as Node does; a throw from `respond` is emitted as
 * the child's `error`, so a broken test fails instead of hanging.
 * Install it before requiring code that destructures spawn at load time.
 */
function installFakeSpawn(respond = () => ({})) {
  const spawns = [];
  const realSpawn = cp.spawn;
  cp.spawn = (cmd, argv, opts) => {
    const call = [cmd, argv, { ...opts }];
    spawns.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let input = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        input += chunk;
        cb();
      },
      final(cb) {
        call[2].input = input;
        let response;
        try {
          response = respond(call) || {};
        } catch (err) {
          response = { error: err };
        }
        setImmediate(() => {
          if (response.error) {
            child.emit('error', response.error);
            child.emit('close', -2, null);
            return;
          }
          child.stdout.end(response.stdout || '');
          child.stderr.end(response.stderr || '');
          setImmediate(() => child.emit('close', response.signal ? null : (response.status ?? 0), response.signal ?? null));
        });
        cb();
      },
    });
    return child;
  };
  return { spawns, restore: () => { cp.spawn = realSpawn; } };
}

module.exports = { installFakeSpawn };
