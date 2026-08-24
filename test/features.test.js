import test from 'node:test';
import assert from 'node:assert/strict';
import { featurize, tokenize, stem, domainOf, describeFeature } from '../src/features.js';

test('tokenize keeps technical tokens intact', () => {
  assert.deepEqual(tokenize('Rust 1.80: C++ interop, .NET and GPT-4'),
    ['rust', '1.80', 'c++', 'interop', 'net', 'and', 'gpt-4']);
});

test('curly and straight apostrophes vanish instead of splitting off junk tokens', () => {
  assert.deepEqual(tokenize('Isn\u2019t Musk\u2019s X'), ['isnt', 'musks', 'x']);
  assert.deepEqual(tokenize("What's Apple's plan"), ['whats', 'apples', 'plan']);
});

test('stem collapses common suffixes but leaves short words alone', () => {
  assert.equal(stem('compilers'), 'compil');
  assert.equal(stem('rust'), 'rust');
  assert.equal(stem('news'), 'news');
});

test('domainOf strips www and lowercases', () => {
  assert.equal(domainOf('https://WWW.Example.com/a/b?c=1'), 'example.com');
  assert.equal(domainOf(null), null);
  assert.equal(domainOf('not a url'), null);
});

test('featurize captures words, phrases, site and style', () => {
  const f = featurize({ title: 'Show HN: A tiny compiler', url: 'https://blog.example.co.uk/x', author: 'ada' });
  assert.equal(f.get('__bias__'), 1);
  assert.ok(f.has('w:compil'));
  assert.ok(f.has('b:show_hn'));
  assert.ok(f.has('t:showhn'));
  assert.equal(f.get('dom:blog.example.co.uk'), 1);
  assert.ok(f.has('dom:example.co.uk'), 'registrable domain is a separate, weaker signal');
  assert.ok(f.has('by:ada'));
});

test('featurize marks text posts and questions', () => {
  const f = featurize({ title: 'Ask HN: Is Kubernetes worth it?' });
  assert.ok(f.has('t:selfpost'));
  assert.ok(f.has('t:question'));
  assert.ok(f.has('t:askhn'));
});

test('hyphenated words also emit their parts', () => {
  const f = featurize({ title: 'LLM-assisted refactoring' });
  assert.ok(f.has('w:llm-assist'));
  assert.equal(f.get('w:llm'), 0.5);
});

test('describeFeature produces readable labels', () => {
  assert.deepEqual(describeFeature('dom:github.com'), { kind: 'site', label: 'github.com' });
  assert.deepEqual(describeFeature('b:borrow_checker'), { kind: 'phrase', label: 'borrow checker' });
  assert.equal(describeFeature('t:showhn').label, 'Show HN posts');
});
