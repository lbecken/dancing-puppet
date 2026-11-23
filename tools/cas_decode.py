#!/usr/bin/env python3
"""Decode a TRS-80 Model III 1500-baud SYSTEM cassette image (.cas).

Verified format of data/source/dandem2.cas:
  * 256 x 0x55 leader, then 0x7F sync byte (byte aligned)
  * after the sync, every byte is stored as 9 bits: a 0 start bit + 8 data bits
    (MSB first), packed as a continuous bit stream
  * SYSTEM tape layout: 0x55, 6-char name, blocks of
        0x3C, len (0 = 256), addr lo, addr hi, data[len], checksum
    and an end record 0x78, entry lo, entry hi.

Usage: cas_decode.py input.cas output.bin  -> writes the memory image and
prints the load map. The image starts at the lowest loaded address.
"""
import json
import sys


def decode(path):
    raw = open(path, 'rb').read()
    i = 0
    while raw[i] == 0x55:
        i += 1
    if raw[i] != 0x7F:
        raise ValueError('no 0x7F sync byte after leader')
    bits = []
    for b in raw[i + 1:]:
        bits.extend((b >> k) & 1 for k in range(7, -1, -1))
    data, bad = [], 0
    for p in range(0, len(bits) - 8, 9):
        bad += bits[p]
        v = 0
        for x in bits[p + 1:p + 9]:
            v = (v << 1) | x
        data.append(v)
    if data[0] != 0x55:
        raise ValueError('not a SYSTEM tape')
    name = bytes(data[1:7]).decode('latin1')
    mem, blocks, entry, j = {}, [], None, 7
    while j < len(data):
        t = data[j]
        if t == 0x3C:
            n = data[j + 1] or 256
            addr = data[j + 2] | (data[j + 3] << 8)
            payload = data[j + 4:j + 4 + n]
            ok = ((addr & 0xFF) + (addr >> 8) + sum(payload)) & 0xFF == data[j + 4 + n]
            blocks.append({'addr': addr, 'len': n, 'checksum_ok': ok})
            for k, x in enumerate(payload):
                mem[addr + k] = x
            j += 5 + n
        elif t == 0x78:
            entry = data[j + 1] | (data[j + 2] << 8)
            break
        else:
            raise ValueError('unexpected record type %02X' % t)
    lo, hi = min(mem), max(mem)
    image = bytearray(hi - lo + 1)
    for a, x in mem.items():
        image[a - lo] = x
    return {
        'name': name, 'entry': entry, 'base': lo, 'image': bytes(image),
        'blocks': blocks, 'bad_start_bits': bad,
    }


def main():
    info = decode(sys.argv[1])
    open(sys.argv[2], 'wb').write(info['image'])
    meta = {
        'name': info['name'],
        'entry': '%04X' % info['entry'],
        'base': '%04X' % info['base'],
        'size': len(info['image']),
        'blocks': len(info['blocks']),
        'all_checksums_ok': all(b['checksum_ok'] for b in info['blocks']),
        'bad_start_bits': info['bad_start_bits'],
    }
    print(json.dumps(meta, indent=2))


if __name__ == '__main__':
    main()
