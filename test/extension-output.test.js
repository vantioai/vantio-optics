'use strict';

// VAN-395: the editor extension reuses one output channel per title and
// disposes it with the extension, instead of a new channel per command.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const EXTENSION = path.join(__dirname, '..', 'extensions', 'vantio-optics', 'extension.js');

function loadWithFakeVscode() {
  const created = [];
  const commands = new Map();
  const fake = {
    window: {
      createOutputChannel(name) {
        const channel = { name, lines: [], disposed: false, clear() { this.lines = []; }, appendLine(line) { this.lines.push(line); }, show() {}, dispose() { this.disposed = true; } };
        created.push(channel);
        return channel;
      },
    },
    commands: {
      registerCommand(name, fn) {
        commands.set(name, fn);
        return { dispose() {} };
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[EXTENSION];
    return { ext: require(EXTENSION), created, commands };
  } finally {
    Module._load = originalLoad;
  }
}

test('running a command twice reuses its output channel', async () => {
  const { ext, created, commands } = loadWithFakeVscode();
  const context = { subscriptions: [] };
  ext.activate(context);
  await commands.get('vantio.upgradePath')();
  await commands.get('vantio.upgradePath')();
  assert.equal(created.length, 1);
  assert.equal(created[0].lines.length, 1, 'the channel is cleared before each run');
  assert.ok(context.subscriptions.includes(created[0]), 'the channel is disposed with the extension');
  ext.deactivate();
});

test('different commands still get their own channel', async () => {
  const { ext, created, commands } = loadWithFakeVscode();
  ext.activate({ subscriptions: [] });
  await commands.get('vantio.upgradePath')();
  await commands.get('vantio.prove')();
  assert.deepEqual(created.map((c) => c.name), ['Vantio Optics · Upgrade path', 'Vantio Optics · Prove']);
  ext.deactivate();
});
