//! The shape of the module graph, checked by walking it.
//!
//! The split exists to make the front end legible, and that only holds if the
//! edges stay pointed the right way. These are real assertions rather than
//! tripwires: the graph is parsed out of the actual imports and traversed, so
//! a cycle is *found*, not guessed at from the text of one file.
//!
//! Cycles matter more here than they look. ES modules tolerate them — function
//! declarations hoist, so a cycle usually works — right up until one binding is
//! read during initialisation and is still in its temporal dead zone. That is a
//! bug that appears on a page load, in one browser, once the file order shifts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../public/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));

const graph = new Map(files.map((f) => [f, [...readFileSync(new URL(f, DIR), 'utf8')
  .matchAll(/^\s*import\s+(?:[^'"]*from\s*)?['"]\.\/([\w-]+\.js)['"]/gm)]
  .map((m) => m[1])]));

const VIEWS = ['train.js', 'explore.js', 'feed.js', 'votes.js', 'brain.js'];

test('every import resolves to a file that exists', () => {
  for (const [from, deps] of graph) {
    for (const to of deps) assert.ok(graph.has(to), `${from} imports missing ${to}`);
  }
});

test('the module graph is acyclic', () => {
  const state = new Map();
  const trail = [];
  const walk = (node) => {
    if (state.get(node) === 'done') return;
    assert.equal(state.get(node), undefined, `cycle: ${[...trail, node].join(' -> ')}`);
    state.set(node, 'open');
    trail.push(node);
    for (const dep of graph.get(node)) walk(dep);
    trail.pop();
    state.set(node, 'done');
  };
  for (const f of files) walk(f);
});

test('no view imports another view', () => {
  // Views reach each other through the registry, never directly. Two edges
  // used to exist: Brain called into the feed to open a histogram bucket (it
  // navigates to `/feed?s=70-75` now), and the router called every view's
  // loader (they register a `show` hook instead).
  for (const view of VIEWS) {
    for (const dep of graph.get(view)) {
      assert.ok(!VIEWS.includes(dep), `${view} imports ${dep}; use the registry`);
    }
  }
});

test('the router imports no view, and app.js imports them all', () => {
  // The router is what would make a cycle if anything did: it starts views.
  for (const dep of graph.get('router.js')) {
    assert.ok(!VIEWS.includes(dep), `router.js imports ${dep}`);
  }
  // Registration only runs if something imports the module. A view missing
  // here is a tab that opens to an empty panel.
  for (const view of VIEWS) {
    assert.ok(graph.get('app.js').includes(view), `app.js never imports ${view}`);
  }
});

test('every view registers itself', () => {
  for (const view of VIEWS) {
    const src = readFileSync(new URL(view, DIR), 'utf8');
    assert.match(src, /^register\(/m, `${view} never calls register()`);
  }
});

test('the leaf modules stay leaves', () => {
  // These are imported by tests and by nearly every view. A dependency here is
  // how a cycle gets in, and format/certainty/feed-params must additionally
  // stay DOM-free so they can be imported and run at all.
  for (const leaf of ['format.js', 'certainty.js', 'feed-params.js', 'registry.js']) {
    assert.deepEqual(graph.get(leaf), [], `${leaf} is no longer a leaf`);
    const src = readFileSync(new URL(leaf, DIR), 'utf8');
    assert.ok(!/\bdocument\b|\bwindow\b/.test(src), `${leaf} touches the DOM`);
  }
});
