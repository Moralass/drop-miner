import { test } from "node:test";
import assert from "node:assert/strict";

process.env.KEY_PEPPER = "test-pepper-1234567890";
const { generateCode, normalizeCode, hashCode, hintOf } = await import("./keys.js");

test("генерируемые ключи имеют нужный формат и не повторяются", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const c = generateCode();
    assert.match(c, /^DM-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    const n = normalizeCode(c)!;
    assert.equal(n.length, 16);
    assert.ok(!seen.has(n), "дубликат ключа");
    seen.add(n);
  }
});

test("ввод в разном виде даёт тот же ключ, путаница символов исправляется", () => {
  const c = generateCode();
  const n = normalizeCode(c)!;
  assert.equal(normalizeCode(c.toLowerCase()), n);
  assert.equal(normalizeCode("  " + c.replace(/-/g, " ") + " "), n);
  assert.equal(normalizeCode(n), n);
  assert.equal(normalizeCode("DD-OOOO-IIII-LLLL-0011"), "0000111111110011");
});

test("мусор отвергается", () => {
  const c = generateCode();
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode("DD-1234"), null);
  assert.equal(normalizeCode("DD-UUUU-UUUU-UUUU-UUUU"), null);
  assert.equal(normalizeCode(c + "A"), null);
});

test("хэш детерминирован, зависит от pepper, без pepper не работает", () => {
  const n = normalizeCode(generateCode())!;
  const h = hashCode(n);
  assert.equal(h, hashCode(n));
  assert.equal(h.length, 64);
  assert.notEqual(h, hashCode(normalizeCode(generateCode())!));
  assert.equal(hintOf(n), n.slice(-4));
  process.env.KEY_PEPPER = "another-pepper-1234567890";
  assert.notEqual(hashCode(n), h);
  delete process.env.KEY_PEPPER;
  assert.throws(() => hashCode(n), /KEY_PEPPER/);
  process.env.KEY_PEPPER = "test-pepper-1234567890";
});

test("ключ со старым префиксом DD по-прежнему распознаётся", () => {
  assert.equal(normalizeCode("DD-0000-1111-2222-3333"), normalizeCode("DM-0000-1111-2222-3333"));
});
