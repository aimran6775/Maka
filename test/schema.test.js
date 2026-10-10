import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid, deepFreeze } from '../shared/schema.js';

test('primitive types', () => {
  assert.equal(validate({ type: 'string' }, 'a').ok, true);
  assert.equal(validate({ type: 'string' }, 1).ok, false);
  assert.equal(validate({ type: 'integer' }, 1).ok, true);
  assert.equal(validate({ type: 'integer' }, 1.5).ok, false);
  assert.equal(validate({ type: 'number' }, NaN).ok, false);
  assert.equal(validate({ type: 'boolean' }, false).ok, true);
  assert.equal(validate({ type: 'null' }, null).ok, true);
  assert.equal(validate({ type: 'object' }, null).ok, false);
  assert.equal(validate({ type: 'object' }, []).ok, false);
  assert.equal(validate({ type: 'array' }, []).ok, true);
  assert.equal(validate({ type: ['number', 'null'] }, null).ok, true);
});

test('objects: required, additionalProperties, nested paths', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: { a: { type: 'integer', minimum: 1 }, b: { type: 'object', properties: { c: { type: 'string' } } } },
  };
  assert.equal(validate(schema, { a: 1 }).ok, true);
  const missing = validate(schema, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].path, '$.a');
  const extra = validate(schema, { a: 1, z: 2 });
  assert.equal(extra.errors[0].path, '$.z');
  const nested = validate(schema, { a: 1, b: { c: 3 } });
  assert.equal(nested.errors[0].path, '$.b.c');
  assert.equal(validate(schema, { a: 0 }).ok, false);
});

test('arrays, enums, const, strings, anyOf', () => {
  assert.equal(validate({ type: 'array', items: { type: 'string' }, minItems: 1 }, ['x']).ok, true);
  assert.equal(validate({ type: 'array', items: { type: 'string' } }, ['x', 1]).errors[0].path, '$[1]');
  assert.equal(validate({ type: 'array', minItems: 1 }, []).ok, false);
  assert.equal(validate({ enum: ['a', 'b'] }, 'c').ok, false);
  assert.equal(validate({ const: 1 }, 1).ok, true);
  assert.equal(validate({ const: 1 }, '1').ok, false);
  assert.equal(validate({ type: 'string', minLength: 1 }, '').ok, false);
  assert.equal(validate({ type: 'string', pattern: '^[a-z]+$' }, 'abc').ok, true);
  assert.equal(validate({ type: 'string', pattern: '^[a-z]+$' }, 'ABC').ok, false);
  assert.equal(validate({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null).ok, true);
  assert.equal(validate({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 2).ok, false);
});

test('assertValid throws with code and path detail', () => {
  assert.throws(() => assertValid({ type: 'string' }, 5, 'thing'), (err) => {
    assert.equal(err.code, 'SCHEMA_INVALID');
    assert.match(err.message, /thing failed validation: \$: expected string/);
    return true;
  });
  assert.equal(assertValid({ type: 'string' }, 'ok'), 'ok');
});

test('deepFreeze freezes nested structures', () => {
  const o = deepFreeze({ a: { b: [1, { c: 2 }] } });
  assert.equal(Object.isFrozen(o.a.b[1]), true);
  assert.throws(() => { 'use strict'; o.a.b[1].c = 3; });
});
