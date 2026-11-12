import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { envSplitWords } from './envSplit.ts'

test('env -S strings split by whitespace, quotes and escapes, with no shell syntax', () => {
  expect(envSplitWords('A=1; python  -c\t1')).toEqual(['A=1;', 'python', '-c', '1'])
  expect(envSplitWords(`a 'b c' "d e" f'g'`)).toEqual(['a', 'b c', 'd e', 'fg'])
  expect(envSplitWords("'a\\'b' 'c\\d' \"x\\\"y\" \"p\\_q\"")).toEqual(["a'b", 'c\\d', 'x"y', 'p q'])
  expect(envSplitWords('a\\_b\\tc\\#d\\$e')).toEqual(['a', 'b\tc#d$e'])
  expect(envSplitWords('a # b')).toEqual(['a'])
  expect(envSplitWords('a#b')).toEqual(['a#b'])
  expect(envSplitWords('a \\c b')).toEqual(['a'])
  expect(envSplitWords("'$x'")).toEqual(['$x'])
  expect(envSplitWords('')).toEqual([])
  expect(envSplitWords('echo ${HOME} "a${B:-c d}" x')).toEqual(['echo', '${HOME}', 'a${B:-c d}', 'x'])
})

test('env -S strings that cannot be followed give undefined', () => {
  for (const text of ['${X', '$X', '"$X"', '"a', "'a", 'a\\q', '"a\\c"', 'a\\']) expect([text, envSplitWords(text)]).toEqual([text, undefined])
})
