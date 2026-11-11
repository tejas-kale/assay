import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { bashRunsPython } from './bashGuard.ts'

function expectDecisions(runsPython: boolean, commands: readonly string[]) {
  for (const command of commands) expect([command, bashRunsPython(command)]).toEqual([command, runsPython])
}

test('a Python program given code is refused, however the program is named or wrapped', () => {
  expectDecisions(true, [
    'python x.py',
    'python3 script.py arg',
    'python3.12 x.py',
    'python2.7 x.py',
    'ipython x.py',
    'ipython3 x.py',
    '/usr/bin/python3 x.py',
    './.venv/bin/python x.py',
    'python -c "print(1)"',
    'python -cprint(1)',
    'python -Bc "print(1)"',
    'python -c',
    'python -',
    'python -W ignore x.py',
    'python -Wc',
    'python -u -B x.py',
    'FOO=1 python x.py',
    'A=1 B=2 python x.py',
    'env python x.py',
    'env -i python x.py',
    'time python x.py',
    'nohup python x.py',
    'exec python x.py',
    'sudo -E python x.py',
    'command python x.py',
    'builtin python x.py',
    'stdbuf -oL python x.py',
    '/usr/bin/env python x.py',
    'timeout 5 python x.py',
    '/usr/bin/timeout 5 python x.py',
    'timeout 5 env python x.py',
  ])
})

test('a wrapper with a flag that takes a value is not seen through, and uv run python with no arguments runs no code', () => {
  expectDecisions(false, ['nice -n 5 python x.py', 'uv run ipython'])
})

test('python run through uv or a shell is refused too', () => {
  expectDecisions(true, [
    'uv run python x.py',
    '/usr/local/bin/uv run python -c "1"',
    'uv run --with pandas python x.py',
    'uv run python3.11 x.py',
    "bash -c 'python x.py'",
    'sh -c "python3 -c 1"',
    '/bin/zsh -c "FOO=1 python x.py"',
    "bash -c \"bash -c 'python x.py'\"",
    "bash -c \"bash -c \\\"bash -c 'python x.py'\\\"\"",
    "bash -c 'ls; python x.py'",
    'bash -c "echo | python"',
  ])
})

test('python fed by a pipe, a redirect or a heredoc is refused', () => {
  expectDecisions(true, [
    'cat x.py | python',
    'echo 1 | python3 --',
    'python < x.py',
    'python <<EOF\nprint(1)\nEOF',
    "python <<'EOF'\nprint(1)\nEOF",
    'python <<-"EOF"\nprint(1)\nEOF',
    'python <<< "print(1)"',
    'cat x | uv run python',
    'python <<EOF\nprint(1)',
    'ls && python x.py',
    'ls; python x.py',
    'ls || python x.py',
    'ls & python x.py',
    'ls\npython x.py',
    'x=1;python x.py',
    'cat a | grep b | python',
  ])
})

test('a heredoc body is not read as commands, and the lines after it are', () => {
  expectDecisions(false, [
    'cat <<EOF\npython x.py\nEOF',
    "cat <<'END'\npython x.py\nEND",
    'cat <<-EOF\npython x.py\n  EOF\nls',
    'cat <<EOF\npython x.py\nEOF\necho done',
    'cat <<EOF\npython x.py',
  ])
  expectDecisions(true, ['cat <<EOF\nhello\nEOF\npython x.py', 'cat <<EOF > f\nhi\nEOF\npython x.py'])
})

test('python that runs no code, other programs and empty input are allowed', () => {
  expectDecisions(false, [
    '',
    '   ',
    ';',
    '&&',
    'ls',
    'python',
    'python3',
    'python -m pytest tests',
    'python -mpytest',
    'python3 -m pip install x',
    'python --version',
    'python -V',
    'python -VV',
    'python --help',
    'python -h',
    'python -m',
    'python -u',
    'python -B -u',
    'python --foo',
    'python --cache',
    'python -x1',
    'python -m pytest x.py',
    'uv run pytest',
    'uv run python -m pytest',
    'uv run python --version',
  ])
})

test('uv without python, package commands and words that only mention python run no Python', () => {
  expectDecisions(false, [
    'uv sync',
    'uv run',
    'pytest tests',
    'pip install pandas',
    'ls python',
    'echo python x.py',
    'echo "python x.py"',
    "echo 'a | python'",
    'grep python x.py',
    'pythonx x.py',
    'python-config x.py',
    'xpython x.py',
    'FOO=1',
    'FOO=1 ls',
    'env',
    'env -i',
    'timeout',
    'timeout 5',
    'time ls',
  ])
})

test('a shell without a script, and other programs, run no Python', () => {
  expectDecisions(false, [
    'bash x.sh',
    'bash -c',
    'bash -c ls',
    "bash -c 'ls | wc'",
    'bash script.sh python',
    'ls < x.txt',
    'ls <(echo python)',
    'cat x.py > out',
  ])
})

test('quotes and backslashes keep a word together and hide the separators in it', () => {
  expectDecisions(false, ["echo 'a; python x.py'", 'echo "a && python x.py"', 'echo a\\;python x.py', 'echo \\| python', 'echo "a\\"; python x.py"'])
  expectDecisions(true, ["'python' x.py", '"python3" x.py', 'pyth\\on x.py', 'p"yth"on x.py', 'echo "a\\"b" ; python x.py', "echo 'it'; python x.py", 'echo "x" | python'])
})

test('only a single pipe marks the next segment as fed', () => {
  expectDecisions(false, ['echo 1 || python', 'echo 1 && python', 'echo 1 ; python', 'echo 1 & python', 'echo 1 ||| python', 'echo 1 |& python -m x'])
  expectDecisions(true, ['echo 1 | python', 'echo 1|python', 'echo 1 || echo | python'])
})

test('a trailing backslash and an unclosed quote end the command without a crash', () => {
  expectDecisions(false, ['echo \\', 'echo "abc', "echo 'abc", 'python -m "pytest'])
  expectDecisions(true, ['python x.py \\', 'python "x.py'])
})
