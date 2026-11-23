/* test/helper.js — 极简测试收集器与断言（无外部依赖） */
'use strict';

function createSuite() {
  const tests = [];
  function test(name, fn) { tests.push({ name, fn }); }
  return { test, tests };
}

function jsonSafe(v) {
  try {
    return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x));
  } catch (e) { return String(v); }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEq') + '：actual=' + jsonSafe(actual) + ' expected=' + jsonSafe(expected));
  }
}
function assertDeepEq(actual, expected, msg) {
  const a = jsonSafe(actual), b = jsonSafe(expected);
  if (a !== b) throw new Error((msg || 'assertDeepEq') + '：actual=' + a + ' expected=' + b);
}
function assertThrows(fn, msgIncludes, name) {
  try { fn(); } catch (e) {
    if (msgIncludes && !String(e.message || e).includes(msgIncludes)) {
      throw new Error((name || 'assertThrows') + '：错误信息不含 "' + msgIncludes + '"，实际：' + e.message);
    }
    return;
  }
  throw new Error((name || 'assertThrows') + '：未抛出异常');
}

module.exports = { createSuite, assert, assertEq, assertDeepEq, assertThrows };
