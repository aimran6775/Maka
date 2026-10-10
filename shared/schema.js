// Tiny JSON-schema-like validator shared by the sidecar and the frontend.
// Deliberately small: it supports exactly what shared/events.js needs.
//
// Supported keywords:
//   type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
//         or an array of those
//   properties, required, additionalProperties (boolean, default false for objects
//   declared in this file's callers; the validator itself defaults to true)
//   items
//   enum, const
//   minLength, maxLength, pattern (string)
//   minimum, maximum (number / integer)
//   minItems, maxItems (array)
//   anyOf
//
// validate(schema, value) -> { ok: boolean, errors: Array<{ path: string, message: string }> }

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'integer') return actual === 'number' && Number.isInteger(value);
  if (expected === 'number') return actual === 'number' && Number.isFinite(value);
  return expected === actual;
}

function check(schema, value, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: 'no value allowed' });
    return;
  }
  if (schema.const !== undefined) {
    if (value !== schema.const) errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value).ok);
    if (!ok) errors.push({ path, message: 'matches none of the allowed shapes' });
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push({ path, message: `expected ${types.join('|')}, got ${typeOf(value)}` });
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` });
    return;
  }
  const t = typeOf(value);
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `shorter than ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `longer than ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match /${schema.pattern}/` });
    }
  } else if (t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `above maximum ${schema.maximum}` });
    }
  } else if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `fewer than ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `more than ${schema.maxItems} items` });
    }
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  } else if (t === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path: `${path}.${key}`, message: 'required' });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) check(sub, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push({ path: `${path}.${key}`, message: 'unexpected property' });
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!(key in props)) check(schema.additionalProperties, value[key], `${path}.${key}`, errors);
      }
    }
  }
}

export function validate(schema, value) {
  const errors = [];
  check(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}

// Throws a descriptive Error when the value does not match.
export function assertValid(schema, value, label = 'value') {
  const result = validate(schema, value);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    const err = new Error(`${label} failed validation: ${detail}`);
    err.code = 'SCHEMA_INVALID';
    err.errors = result.errors;
    throw err;
  }
  return value;
}

// Deep-freezes plain objects and arrays in place and returns the input.
export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}
