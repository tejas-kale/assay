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

test('uv run python with no arguments runs no code', () => {
  expectDecisions(false, ['uv run ipython'])
})

test('a wrapper is seen through past its options that take a value (audit finding PI-1)', () => {
  expectDecisions(true, [
    'nice -n 5 python x.py',
    'nice --adjustment 5 python x.py',
    'timeout -s KILL 5 python x.py',
    'timeout --signal KILL -k 1 5 python x.py',
    'timeout --signal=KILL 5 python x.py',
    'env -u HOME python x.py',
    'env -C /tmp python x.py',
    'env -- python x.py',
    "env -S 'python x.py'",
    "env -S'python x.py'",
    "env --split-string='python -c 1'",
    'sudo -u root python x.py',
    'time -f %e python x.py',
    'stdbuf -o L python x.py',
    'exec -a name python x.py',
    'caffeinate -t 60 python x.py',
    'ls *.py | xargs python',
    'ls | xargs -n 1 python',
    'xargs -a list.txt python',
    'find . -name x.py -exec python {} \\;',
    'find . -execdir python3 {} +',
  ])
})

test('shells, eval, grouping, substitutions and variables are seen through (audit PI-5)', () => {
  expectDecisions(true, [
    'bash -lc "python x.py"',
    'bash -c -- "python x.py"',
    'dash -c "python x.py"',
    "fish -c 'python x.py'",
    'eval python x.py',
    "eval 'python -c 1'",
    'watch -n 5 python x.py',
    "watch 'python x.py'",
    '(python x.py)',
    '{ python x.py; }',
    'if true; then python x.py; fi',
    'for f in a; do python x.py; done',
    '! python x.py',
    'echo $(python x.py)',
    'echo `python -c 1`',
    'diff <(python a.py) b.txt',
    '$(which python) x.py',
    '`which python3` x.py',
    'p=python; $p x.py',
    'P\\ython x.py',
    'Python3 x.py',
    'flock /tmp/l python x.py',
    'arch -arm64 python x.py',
  ])
})

test('other names and launchers of Python are refused, and modules that run code (audit PI-5)', () => {
  expectDecisions(true, [
    'python -m runpy x.py',
    'python -mrunpy x.py',
    'python -m code',
    "python -m timeit 'x=1'",
    'python3.13t x.py',
    'pypy3 x.py',
    'py x.py',
    'uv run x.py',
    'uv run --with pandas x.py',
    'uvx python x.py',
    'uv tool run python -c 1',
    'jupyter execute nb.ipynb',
    'jupyter nbconvert --execute nb.ipynb',
    'streamlit run app.py',
    'marimo run nb.py',
  ])
  expectDecisions(false, ['python -m pytest tests', 'uv run pytest', 'uv run python -m pytest', 'uvx ruff check', 'jupyter --version', 'echo $(date)', 'echo $HOME', 'git commit -m "$(cat msg)"', 'uv pip install pandas'])
})

test('a wrapper running something else, or env -S without python, passes', () => {
  expectDecisions(false, ['nice -n 5 ls', "env -S 'ls -l'", 'env -S', 'xargs rm', 'find . -name "*.py"', 'find . -exec cat {} \\;'])
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

test('PI-5: combined short wrapper options that end in an option taking a value do not hide the program', () => {
  expectDecisions(true, [
    'env -iu HOME /opt/py/bin/python -B -c 1',
    'env -iuHOME python x.py',
    'sudo -Eu root python x.py',
    'nice -n5 python x.py',
    'xargs -0n 1 python x.py',
    'timeout -vk 5 9 python x.py',
    'find . -exec python x.py {} +',
  ])
  expectDecisions(false, ['env -i FOO=1 ls', 'env -iu HOME ls', 'sudo -Eu root ls', 'nice -n5 ls', 'xargs -0n 1 echo'])
})

test('PI-5: a leading redirection does not hide the program', () => {
  expectDecisions(true, [
    '>/dev/null python -B -c 1',
    '2>&1 python -c 1',
    '<in python -c 1',
    '< in python x.py',
    '2> err python x.py',
    '>> log python x.py',
    '&>/dev/null python x.py',
    'FOO=1 >/dev/null python -c 1',
  ])
  expectDecisions(false, ['>/dev/null ls', '2>&1 ls', '<in cat', '> out echo hi', 'ls 2>&1', '>/dev/null python -m pytest'])
})

test('PI-5: shell wrappers nested beyond the old depth limit are still refused, and too deep counts as Python', () => {
  const quoted = (script: string) => "'" + script.replaceAll("'", "'\\''") + "'"
  const wrap = (script: string, times: number): string => (times === 0 ? script : wrap('bash -c ' + quoted(script), times - 1))
  expectDecisions(true, [wrap('python -c 1', 3), wrap('python -c 1', 5)])
  expectDecisions(true, [wrap('ls', 12)])
  expectDecisions(false, [wrap('ls', 2)])
  expectDecisions(true, ['echo $(echo $(echo $(echo $(echo $(echo $(echo $(python x.py)))))))'])
})

test('PI-5: a numbered or here-string redirection does not hide the program', () => {
  expectDecisions(true, [
    '0</dev/null python -c 1',
    '3<in python -c 1',
    '0< in python x.py',
    "0<<EOF python -c 1\nEOF",
    "<<<'x' python -c 1",
    "0<<<'x' python -c 1",
    '9>&1 python -c 1',
    '&>>log python -c 1',
    'FOO=1 0</dev/null python -c 1',
  ])
  expectDecisions(false, ['0</dev/null ls', '3<in cat', "<<<'x' cat", '9>&1 ls', '&>>log ls', '0</dev/null python -m pytest'])
})

test('PI-5: env split-string options are read in combined groups, attached and long forms', () => {
  expectDecisions(true, [
    'env -iS "FOO=1 python -c 1"',
    'env -iS\'python -c 1\'',
    "env -S'python -c 1'",
    'env -Spython\\ -c\\ 1',
    "env --split-string='python -c 1'",
    "env --split-string 'python -c 1'",
    "env --split='python -c 1'",
    "env -vS 'FOO=1 python x.py'",
  ])
  expectDecisions(false, ["env -iS 'FOO=1 ls'", "env -S'ls -l'", "env --split-string='echo hi'", "env -iS 'python -m pytest'", 'env -iuS ls'])
})

test('PI-5: substitutions are read with their quotes, nesting and backticks', () => {
  expectDecisions(true, [
    'echo $(python -c "print(1)")',
    "echo $(python -c 'print(1)')",
    'echo "$(python -c "print(1)")"',
    'echo $(echo ")" ; python -c 1)',
    'echo $(echo $(python -c "print(1)"))',
    'echo `python -c "print(1)"`',
    'echo `echo \\`python -c 1\\``',
    'cat <(python -c "print(1)")',
    'echo "a" $(printf ")" | python -c 1)',
    'echo $(python -c "print(1)"',
    'echo `python -c 1',
  ])
  expectDecisions(false, [
    'echo $(ls "a)b")',
    "echo $(ls 'a)b')",
    'echo "$(ls "a)b")"',
    "echo '$(python -c 1)'",
    'echo \\$(python -c 1)',
    'echo $((1+2))',
    'diff <(ls "a)b") x',
  ])
})

test('PI-5: env -S splits its string by env rules, not shell syntax', () => {
  expectDecisions(true, [
    `env -iS 'FOO=1; python3 -I -B -c "print(1)"'`,
    "env -S 'FOO=1; python3 -c 1'",
    "env -S 'python3\\_-c\\_1'",
    `env -S 'X="a b" python x.py'`,
    "env -S '${PY} x.py'",
    "env -S 'python x.py \\q'",
  ])
  expectDecisions(false, ["env -S 'FOO=1; ls'", "env -S 'ls # python x.py'", "env -S 'echo \\c python x.py'", "env -S 'echo \"python x.py\"'"])
})

test('PI-5: a shell script run by -c or eval has its substitutions read too', () => {
  expectDecisions(true, [
    `bash -c 'echo $(python3 -c "print(1)")'`,
    `sh -c "$(python -c 1)"`,
    'sh -c "echo `python -c 1`"',
    `bash -c 'echo \`python -c 1\`'`,
    `eval 'echo $(python -c 1)'`,
    `bash -c "bash -c 'echo \\$(python -c 1)'"`,
  ])
  expectDecisions(false, [`bash -c 'echo $(ls)'`, `sh -c 'echo "$(date)"'`])
})

test('PI-5: a comment hides a lone backtick or parenthesis, and only a comment', () => {
  expectDecisions(false, ['echo hi # `', 'echo hi # $(', 'echo hi #`python -c 1`', 'echo a;# `\necho b'])
  expectDecisions(true, ['echo hi#`python -c 1`', 'echo a # c\n echo `python -c 1`', 'echo "# `python -c 1`"', 'echo a\\ #`python -c 1`', 'echo ${#x} `python -c 1`'])
})
