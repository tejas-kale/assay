"""How a trusted calculation's local imports load (PI-2): only from approved files, from the bytes approved.

A calculation in ``<root>/trusted/`` may ``import helper``. Python would find ``trusted/helper.py`` through its file
loader and run it, or run a ``__pycache__`` file planted beside it. While a trusted calculation is described or run,
``trusted_imports`` puts a finder first on ``sys.meta_path``. It lets Python resolve each import as it normally would,
then checks where it landed: a module outside the root is left alone, so the standard library and the venv always win;
a module inside the root loads only when it is a ``.py`` the ledger lists with the hash of the bytes read, compiled
from those bytes (no bytecode cache), and anything else there (unapproved, changed, a ``.pyc``, a native module, a
folder without an approved ``__init__.py``) raises ``ImportError``. A name Python cannot resolve is looked up as a
sibling in ``trusted/``, under the same rule. Today the app approves only a proposal's own files, so a helper is
approvable only as a calculation of its own name (docs/developer/security.md).
"""

from __future__ import annotations

import contextlib
import importlib.abc
import importlib.machinery
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import analysis_ledger

REFUSED = "not approved in the app"


class _ApprovedLoader(importlib.abc.Loader):
    """Runs the bytes the ledger approved."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    def exec_module(self, module: ModuleType) -> None:
        code = compile(self.data, str(module.__file__), "exec", dont_inherit=True)
        exec(code, module.__dict__)


class _TrustedFinder(importlib.abc.MetaPathFinder):
    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.root = folder.parent
        self.ledger = analysis_ledger.load()
        self.loaded: list[str] = []

    def find_spec(
        self, fullname: str, path: object = None, target: object = None
    ) -> importlib.machinery.ModuleSpec | None:
        resolved = self._resolve(fullname, path, target)
        if resolved is not None:
            return self._checked(fullname, resolved)
        base = self.folder.joinpath(*fullname.split("."))
        module, package = base.with_name(base.name + ".py"), base / "__init__.py"
        if module.is_file():
            return self._spec(fullname, module, False)
        if package.is_file() or base.is_dir():
            return self._spec(fullname, package, True)
        return None

    def _resolve(self, fullname: str, path: object, target: object) -> importlib.machinery.ModuleSpec | None:
        """The spec Python's other finders give ``fullname``, or None when none can resolve it."""
        for finder in sys.meta_path:
            find = getattr(finder, "find_spec", None)
            if finder is self or find is None:
                continue
            spec = find(fullname, path, target)
            if spec is not None:
                return spec
        return None

    def _checked(self, fullname: str, spec: importlib.machinery.ModuleSpec) -> importlib.machinery.ModuleSpec:
        """``spec`` itself when outside the root; inside it, only an approved ``.py``, from its approved bytes."""
        places = [spec.origin] if spec.origin and spec.has_location else []
        places += list(spec.submodule_search_locations or [])
        if not any(self._within_root(place) for place in places):
            return spec
        if not (spec.origin and spec.has_location and spec.origin.endswith(".py")):
            raise ImportError(f"{fullname} is {REFUSED}: only an approved .py loads from the root", name=fullname)
        return self._spec(fullname, Path(spec.origin), spec.submodule_search_locations is not None)

    def _within_root(self, place: str) -> bool:
        return Path(place).resolve().is_relative_to(self.root.resolve())

    def _spec(self, fullname: str, file: Path, is_package: bool) -> importlib.machinery.ModuleSpec:
        relative = file.relative_to(self.root).as_posix()
        read = analysis_ledger.read_checked(self.ledger, self.root, relative)
        if read.data is None or not read.trusted:
            raise ImportError(f"{fullname} ({relative}) is {REFUSED}, or changed after it was", name=fullname)
        loader = _ApprovedLoader(read.data)
        spec = importlib.machinery.ModuleSpec(fullname, loader, origin=str(file), is_package=is_package)
        spec.has_location = True
        if is_package:
            spec.submodule_search_locations = [str(file.parent)]
        self.loaded.append(fullname)
        return spec


def _inside(module: ModuleType, folder: Path) -> bool:
    file = getattr(module, "__file__", None)
    return isinstance(file, str) and Path(file).resolve().is_relative_to(folder.resolve())


@contextlib.contextmanager
def trusted_imports(folder: Path) -> Iterator[None]:
    """Within the block, a module that resolves inside ``folder`` (a root's ``trusted/``) loads only when the ledger
    approved its file. Modules the finder loads, and any left from Python's own loader, are dropped from
    ``sys.modules`` on both sides of the block, so no unchecked copy is reused and no approved one outlives it."""
    if folder.name != "trusted":
        yield
        return
    finder = _TrustedFinder(folder)

    def forget() -> None:
        for name in [name for name, module in sys.modules.items() if _inside(module, folder)]:
            del sys.modules[name]

    forget()
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        forget()
