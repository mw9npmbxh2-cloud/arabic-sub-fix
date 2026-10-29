const test = require('node:test');
const assert = require('node:assert');
const { pickFromZip } = require('./server');

// يبني ZIP بسيط (بدون ضغط) من { name: content }
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = Buffer.from(name), d = Buffer.from(content);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(d.length, 18);
    lh.writeUInt32LE(d.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(d.length, 20);
    ch.writeUInt32LE(d.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, d);
    centrals.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('S01E01 does not pick S02E01', () => {
  const zip = makeZip({ 'Show.S02E01.srt': 'wrong', 'Show.S01E01.srt': 'right' });
  assert.strictEqual(pickFromZip(zip, { season: 1, episode: 1 }).toString(), 'right');
});
