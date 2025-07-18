# Copyright 2024 Marimo. All rights reserved.
from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Literal, Optional

from marimo import _loggers
from marimo._ast.cell import (
    CellImpl,
)
from marimo._ast.compiler import code_key
from marimo._ast.variables import is_mangled_local
from marimo._ast.visitor import ImportData, Name, VariableData
from marimo._runtime.executor import (
    ExecutionConfig,
    get_executor,
)
from marimo._types.ids import CellId_t

if TYPE_CHECKING:
    from collections.abc import Collection


Edge = tuple[CellId_t, CellId_t]
# EdgeWithVar uses a list rather than a set for the variables linking the cells
# as sets are not JSON-serializable (required by static_notebook_template()).
# The first entry is the source node; the second entry is a list of defs from
# the source read by the destination; and the third entry is the destination
# node.
EdgeWithVar = tuple[CellId_t, list[str], CellId_t]

LOGGER = _loggers.marimo_logger()


# TODO(akshayka): Add method disable_cell, enable_cell which handle
# state transitions on cells
@dataclass(frozen=True)
class DirectedGraph:
    # Nodes in the graph
    cells: dict[CellId_t, CellImpl] = field(default_factory=dict)

    # Edge (u, v) means v is a child of u, i.e., v has a reference
    # to something defined in u
    children: dict[CellId_t, set[CellId_t]] = field(default_factory=dict)

    # Reversed edges (parent pointers) for convenience
    parents: dict[CellId_t, set[CellId_t]] = field(default_factory=dict)

    # Cells that define the same name
    #
    # siblings[cell_id] is a set of cell ids, one for each cell that shares a
    # definition with cell_id.
    #
    # If this dict is non-empty, then the marimo program contains multiply
    # defined names (and is therefore in an error state)
    siblings: dict[CellId_t, set[CellId_t]] = field(default_factory=dict)

    # A mapping from defs to the cells that define them
    definitions: dict[Name, set[CellId_t]] = field(default_factory=dict)

    # The set of cycles in the graph
    cycles: set[tuple[Edge, ...]] = field(default_factory=set)

    # This lock must be acquired during methods that mutate the graph; it's
    # only needed because a graph is shared between the kernel and the code
    # completion service. It should almost always be uncontended.
    lock: threading.Lock = field(default_factory=threading.Lock)

    def is_cell_cached(self, cell_id: CellId_t, code: str) -> bool:
        """Whether a cell with id `cell_id` and code `code` is in the graph."""
        return (
            cell_id in self.cells and code_key(code) == self.cells[cell_id].key
        )

    # TODO: language type?
    def get_defining_cells(self, name: Name) -> set[CellId_t]:
        """Get all cells that define name.

        This is a singleton for well-formed graphs.
        """
        if name in self.definitions:
            return self.definitions[name]
        else:
            return set()

    def get_referring_cells(
        self, name: Name, language: Literal["python", "sql"]
    ) -> set[CellId_t]:
        """Get all cells that have a ref to `name`.

        The variable can be either a Python variable or a SQL variable (table).
        SQL variables don't leak to Python cells, but Python variables do leak
        to SQL.

        Only does a local analysis of refs, without taking into consideration
        whether refs are defined by other cells.
        """
        if language == "sql":
            # For SQL, only return SQL cells that reference the name
            return {
                cid
                for cid, cell in self.cells.items()
                if name in cell.refs and cell.language == "sql"
            }
        else:
            # For Python, return all cells that reference the name
            return {
                cid for cid, cell in self.cells.items() if name in cell.refs
            }

    def get_path(self, source: CellId_t, dst: CellId_t) -> list[Edge]:
        """Get a path from `source` to `dst`, if any."""
        if source == dst:
            return []

        # deque has O(1) append/pop operation
        queue: deque[tuple[CellId_t, list[Edge]]] = deque([(source, [])])
        found = {source}  # set has O(1) lookups

        while queue:
            node, path = queue.popleft()  # O(1) operation
            for cid in self.children[node]:
                if cid not in found:
                    next_path = path + [(node, cid)]
                    if cid == dst:
                        return next_path
                    found.add(cid)
                    queue.append((cid, next_path))
        return []

    def register_cell(self, cell_id: CellId_t, cell: CellImpl) -> None:
        """Add a cell to the graph.

        Mutates the graph, acquiring `self.lock`.

        Requires that `cell_id` is not already in the graph.
        """
        LOGGER.debug("Acquiring graph lock to register cell %s", cell_id)
        with self.lock:
            LOGGER.debug("Acquired graph lock.")
            assert cell_id not in self.cells
            self.cells[cell_id] = cell
            # Children are the set of cells that refer to a name defined in
            # `cell`
            children: set[CellId_t] = set()
            # Cells that define the same name as this one
            siblings: set[CellId_t] = set()
            # Parents are the set of cells that define a name referred to by
            # `cell`
            parents: set[CellId_t] = set()

            # Populate children, siblings, and parents
            self.children[cell_id] = children
            self.siblings[cell_id] = siblings
            self.parents[cell_id] = parents
            for name, variable_data in cell.variable_data.items():
                self.definitions.setdefault(name, set()).add(cell_id)
                for sibling in self.definitions[name]:
                    # TODO(akshayka): Distinguish between Python/SQL?
                    if sibling != cell_id:
                        siblings.add(sibling)
                        self.siblings[sibling].add(cell_id)

                # a cell can refer to its own defs, but that doesn't add an
                # edge to the dependency graph
                referring_cells = self.get_referring_cells(
                    name,
                    language=variable_data[-1].language,
                ) - set((cell_id,))
                # we will add an edge (cell_id, v) for each v in
                # referring_cells; if there is a path from v to cell_id, then
                # the new edge will form a cycle
                for v in referring_cells:
                    path = self.get_path(v, cell_id)
                    if path:
                        self.cycles.add(tuple([(cell_id, v)] + path))

                children.update(referring_cells)
                for child in referring_cells:
                    self.parents[child].add(cell_id)

            for name in cell.refs:
                other_ids_defining_name: set[CellId_t] = (
                    self.definitions[name]
                    if name in self.definitions
                    else set()
                ) - set((cell_id,))
                # if other is empty, this means that the user is going to
                # get a NameError once the cell is run, unless the symbol
                # is say a builtin
                for other_id in other_ids_defining_name:
                    language = (
                        self.cells[other_id].variable_data[name][-1].language
                    )
                    if language == "sql" and cell.language == "python":
                        # SQL table/db def -> Python ref is not an edge
                        continue
                    parents.add(other_id)
                    # we are adding an edge (other_id, cell_id). If there
                    # is a path from cell_id to other_id, then the new
                    # edge forms a cycle
                    path = self.get_path(cell_id, other_id)
                    if path:
                        self.cycles.add(tuple([(other_id, cell_id)] + path))
                    self.children[other_id].add(cell_id)
        LOGGER.debug("Registered cell %s and released graph lock", cell_id)
        if self.is_any_ancestor_stale(cell_id):
            self.set_stale(set([cell_id]))

        if self.is_any_ancestor_disabled(cell_id):
            cell.set_runtime_state(status="disabled-transitively")

    def is_any_ancestor_stale(self, cell_id: CellId_t) -> bool:
        return any(self.cells[cid].stale for cid in self.ancestors(cell_id))

    def is_any_ancestor_disabled(self, cell_id: CellId_t) -> bool:
        return any(
            self.cells[cid].config.disabled for cid in self.ancestors(cell_id)
        )

    def disable_cell(self, cell_id: CellId_t) -> None:
        """
        Disables a cell in the graph.

        Does not mutate the graph (but does mutate cell statuses).

        Returns the ids of descendants that are disabled transitively.
        """
        if cell_id not in self.cells:
            raise ValueError(f"Cell {cell_id} not found")

        for cid in transitive_closure(self, set([cell_id])) - set([cell_id]):
            cell = self.cells[cid]
            cell.set_runtime_state(status="disabled-transitively")

    def enable_cell(self, cell_id: CellId_t) -> set[CellId_t]:
        """
        Enables a cell in the graph.

        Does not mutate the graph (but does mutate cell statuses).

        Returns:
        - set of cells that were stale and should be re-run
        """
        if cell_id not in self.cells:
            raise ValueError(f"Cell {cell_id} not found")

        cells_to_run: set[CellId_t] = set()
        for cid in transitive_closure(self, set([cell_id])):
            if not self.is_disabled(cid):
                child = self.cells[cid]
                if child.stale:
                    # cell was previously disabled, is no longer
                    # disabled, and is stale: needs to run.
                    cells_to_run.add(cid)
                if child.disabled_transitively:
                    # cell is no longer disabled: status -> idle
                    child.set_runtime_state("idle")
        return cells_to_run

    def delete_cell(self, cell_id: CellId_t) -> set[CellId_t]:
        """Removes a cell from the graph.

        Mutates the graph, acquiring `self.lock`.

        Returns the ids of the children of the removed cell.
        """
        LOGGER.debug("Acquiring graph lock to delete cell %s", cell_id)
        with self.lock:
            LOGGER.debug("Acquired graph lock to delete cell %s", cell_id)
            if cell_id not in self.cells:
                raise ValueError(f"Cell {cell_id} not found")

            # Removing this cell from its defs' definer sets
            for name in self.cells[cell_id].defs:
                name_defs = self.definitions[name]
                name_defs.remove(cell_id)
                if not name_defs:
                    # No more cells define this name, so we remove it from the
                    # graph
                    del self.definitions[name]

            # Remove cycles that are broken from removing this cell.
            edges = [(cell_id, child) for child in self.children[cell_id]] + [
                (parent, cell_id) for parent in self.parents[cell_id]
            ]
            for e in edges:
                broken_cycles = [c for c in self.cycles if e in c]
                for c in broken_cycles:
                    self.cycles.remove(c)

            # Grab a reference to children before we remove it from our map.
            children = self.children[cell_id]

            # Purge this cell from the graph.
            del self.cells[cell_id]
            del self.children[cell_id]
            del self.parents[cell_id]
            del self.siblings[cell_id]

            for elems in self.parents.values():
                if cell_id in elems:
                    elems.remove(cell_id)
            for elems in self.children.values():
                if cell_id in elems:
                    elems.remove(cell_id)
            for elems in self.siblings.values():
                if cell_id in elems:
                    elems.remove(cell_id)
        LOGGER.debug("Deleted cell %s and Released graph lock.", cell_id)
        return children

    def is_disabled(self, cell_id: CellId_t) -> bool:
        if cell_id not in self.cells:
            raise ValueError(f"Cell {cell_id} not in graph.")
        cell = self.cells[cell_id]
        if cell.config.disabled:
            return True
        seen: set[CellId_t] = set()
        queue = [cell_id]
        while queue:
            cid = queue.pop()
            seen.add(cid)
            for parent_id in self.parents[cid]:
                if parent_id in seen:
                    continue
                elif self.cells[parent_id].config.disabled:
                    return True
                else:
                    queue.append(parent_id)
        return False

    def get_imports(
        self, cell_id: Optional[CellId_t] = None
    ) -> dict[Name, ImportData]:
        imports = {}
        cells = (
            self.cells.values() if cell_id is None else [self.cells[cell_id]]
        )
        for cell in cells:
            for imported in cell.imports:
                imports[imported.definition] = imported
        return imports

    def get_multiply_defined(self) -> list[Name]:
        names: list[Name] = []
        for name, definers in self.definitions.items():
            if len(definers) > 1:
                names.append(name)
        return names

    def get_deleted_nonlocal_ref(self) -> list[Name]:
        names: list[Name] = []
        for cell in self.cells.values():
            for ref in cell.deleted_refs:
                if ref in self.definitions:
                    names.append(ref)
        return names

    def descendants(self, cell_id: CellId_t) -> set[CellId_t]:
        return transitive_closure(self, set([cell_id]), inclusive=False)

    def ancestors(self, cell_id: CellId_t) -> set[CellId_t]:
        return transitive_closure(
            self, set([cell_id]), children=False, inclusive=False
        )

    def set_stale(
        self, cell_ids: set[CellId_t], prune_imports: bool = False
    ) -> None:
        relatives = None if not prune_imports else import_block_relatives
        for cid in transitive_closure(self, cell_ids, relatives=relatives):
            self.cells[cid].set_stale(stale=True)

    def get_stale(self) -> set[CellId_t]:
        return set([cid for cid, cell in self.cells.items() if cell.stale])

    def get_transitive_references(
        self,
        refs: set[Name],
        inclusive: bool = True,
        predicate: Callable[[Name, VariableData], bool] | None = None,
    ) -> set[Name]:
        """Return a set of the passed-in cells' references and their
        references on the block (function / class) level.

        If inclusive, includes the references of the passed-in cells in the
        set.

        If predicate, only references satisfying predicate(ref) are included
        """
        # TODO: Consider caching on the graph level and updating on register /
        # delete
        processed: set[Name] = set()
        queue: set[Name] = refs & self.definitions.keys()
        predicate = predicate or (lambda *_: True)

        while queue:
            # Should ideally be one cell per ref, but for completion, stay
            # agnostic to potenital cycles.
            cells = {
                cell_id
                for ref in queue
                for cell_id in self.definitions.get(ref, set())
            }

            for cell_id in cells:
                data = self.cells[cell_id].variable_data
                newly_processed = set(data.keys()) & queue
                processed.update(newly_processed)
                queue.difference_update(newly_processed)
                for variable in newly_processed:
                    # variables can be defined multiple times in a single
                    # cell ...
                    for datum in data[variable]:
                        if predicate(variable, datum):
                            to_process = datum.required_refs - processed
                            queue.update(to_process & self.definitions.keys())
                            # Private variables referenced by public functions
                            # have to be included.
                            processed.update(
                                maybe_private
                                for maybe_private in (
                                    to_process - self.definitions.keys()
                                )
                                if is_mangled_local(maybe_private, cell_id)
                            )

        if inclusive:
            return processed | refs
        return processed - refs


def transitive_closure(
    graph: DirectedGraph,
    cell_ids: set[CellId_t],
    children: bool = True,
    inclusive: bool = True,
    relatives: (
        Callable[[DirectedGraph, CellId_t, bool], set[CellId_t]] | None
    ) = None,
    predicate: Callable[[CellImpl], bool] | None = None,
) -> set[CellId_t]:
    """Return a set of the passed-in cells and their descendants or ancestors

    If children is True, returns descendants; otherwise, returns ancestors

    If inclusive, includes passed-in cells in the set.

    If relatives is not None, it computes the parents/children of a
        cell

    If predicate, only cells satisfying predicate(cell) are included; applied
        after the relatives are computed
    """

    result: set[CellId_t] = cell_ids.copy() if inclusive else set()
    seen: set[CellId_t] = cell_ids.copy()
    queue: deque[CellId_t] = deque(cell_ids)
    predicate = predicate or (lambda _: True)

    def _relatives(cid: CellId_t) -> set[CellId_t]:
        if relatives is None:
            return graph.children[cid] if children else graph.parents[cid]
        return relatives(graph, cid, children)

    while queue:
        cid = queue.popleft()  # O(1) operation

        relatives_set = _relatives(cid)
        new_relatives = relatives_set - seen

        if new_relatives:
            # Add new relatives to queue and result if they pass predicate
            for relative in new_relatives:
                if predicate(graph.cells[relative]):
                    result.add(relative)
                seen.add(relative)
                queue.append(relative)

    return result


def induced_subgraph(
    graph: DirectedGraph, cell_ids: Collection[CellId_t]
) -> tuple[dict[CellId_t, set[CellId_t]], dict[CellId_t, set[CellId_t]]]:
    """Return parents and children for each node in `cell_ids`

    Represents the subgraph induced by `cell_ids`.
    """
    parents: dict[CellId_t, set[CellId_t]] = {}
    children: dict[CellId_t, set[CellId_t]] = {}
    for cid in cell_ids:
        parents[cid] = set(p for p in graph.parents[cid] if p in cell_ids)
        children[cid] = set(c for c in graph.children[cid] if c in cell_ids)
    return parents, children


def get_cycles(
    graph: DirectedGraph, cell_ids: Collection[CellId_t]
) -> list[tuple[Edge, ...]]:
    """Get all cycles among `cell_ids`."""
    _, induced_children = induced_subgraph(graph, cell_ids)
    induced_edges = set(
        [(u, v) for u in induced_children for v in induced_children[u]]
    )
    return [c for c in graph.cycles if all(e in induced_edges for e in c)]


def topological_sort(
    graph: DirectedGraph, cell_ids: Collection[CellId_t]
) -> list[CellId_t]:
    """Sort `cell_ids` in a topological order using a heap queue.

    When multiple cells have the same parents (including no parents), the tie is broken by
    registration order - cells registered earlier are processed first.
    """
    from heapq import heapify, heappop, heappush

    # Use a list for O(1) lookup of registration order
    registration_order = list(graph.cells.keys())
    top_down_keys = {key: idx for idx, key in enumerate(registration_order)}

    # Build adjacency lists and in-degree counts
    parents, children = induced_subgraph(graph, cell_ids)
    in_degree = {cid: len(parents[cid]) for cid in cell_ids}

    # Initialize heap with roots
    heap = [
        (top_down_keys[cid], cid) for cid in cell_ids if in_degree[cid] == 0
    ]
    heapify(heap)

    sorted_cell_ids: list[CellId_t] = []
    while heap:
        _, cid = heappop(heap)
        sorted_cell_ids.append(cid)

        # Process children
        for child in children[cid]:
            in_degree[child] -= 1
            if in_degree[child] == 0:
                heappush(heap, (top_down_keys[child], child))

    return sorted_cell_ids


def import_block_relatives(
    graph: DirectedGraph, cid: CellId_t, children: bool
) -> set[CellId_t]:
    if not children:
        return graph.parents[cid]

    cell = graph.cells[cid]
    if not cell.import_workspace.is_import_block:
        return graph.children[cid]

    # This cell is an import block, which should be special cased:
    #
    # We prune definitions that have already been imported from the set of
    # definitions used to find the descendants of this cell.
    unimported_defs = cell.defs - cell.import_workspace.imported_defs

    children_ids = {
        child_id
        for name in unimported_defs
        for child_id in graph.get_referring_cells(name, language="python")
    }

    # If children haven't been executed, then still use imported defs;
    # handle an edge case when an import cell is interrupted by an
    # exception or user interrupt, so that a module is imported but the
    # cell's children haven't run.
    if cell.import_workspace.imported_defs:
        interrupted_states = {"interrupted", "cancelled", "marimo-error", None}
        children_ids.update(
            child_id
            for name in cell.import_workspace.imported_defs
            for child_id in graph.get_referring_cells(name, language="python")
            if graph.cells[child_id].run_result_status in interrupted_states
        )

    return children_ids


class Runner:
    """Utility for running individual cells in a graph

    This class provides methods to a run a cell in the graph and obtain its
    output (last expression) and the values of its defs.

    If needed, the runner will recursively compute the values of the cell's
    refs by executing its ancestors. Refs can also be substituted by the
    caller.

    TODO(akshayka): Add an API for caching defs across cell runs.
    """

    def __init__(self, graph: DirectedGraph) -> None:
        self._graph = graph
        self._executor = get_executor(ExecutionConfig())

    @staticmethod
    def _returns(cell_impl: CellImpl, glbls: dict[str, Any]) -> dict[str, Any]:
        return {name: glbls[name] for name in cell_impl.defs if name in glbls}

    @staticmethod
    def _substitute_refs(
        cell_impl: CellImpl,
        glbls: dict[str, Any],
        kwargs: dict[str, Any],
    ) -> None:
        for argname, argvalue in kwargs.items():
            if argname in cell_impl.refs:
                glbls[argname] = argvalue
            else:
                raise ValueError(
                    f"Cell got unexpected argument {argname}"
                    f"The allowed arguments are {cell_impl.refs}."
                )

    def _get_ancestors(
        self, cell_impl: CellImpl, kwargs: dict[str, Any]
    ) -> set[CellId_t]:
        # Get the transitive closure of parents defining unsubstituted refs
        graph = self._graph
        substitutions = set(kwargs.keys())
        unsubstituted_refs = cell_impl.refs - substitutions
        parent_ids = set(
            [
                parent_id
                for parent_id in graph.parents[cell_impl.cell_id]
                if graph.cells[parent_id].defs.intersection(unsubstituted_refs)
            ]
        )
        return transitive_closure(graph, parent_ids, children=False)

    @staticmethod
    def _validate_kwargs(cell_impl: CellImpl, kwargs: dict[str, Any]) -> None:
        for argname in kwargs:
            if argname not in cell_impl.refs:
                raise ValueError(
                    f"Cell got unexpected argument {argname}; "
                    f"The allowed arguments are {cell_impl.refs}."
                )

    def is_coroutine(self, cell_id: CellId_t) -> bool:
        return self._graph.cells[cell_id].is_coroutine() or any(
            self._graph.cells[cid].is_coroutine()
            for cid in self._get_ancestors(
                self._graph.cells[cell_id], kwargs={}
            )
        )

    async def run_cell_async(
        self, cell_id: CellId_t, kwargs: dict[str, Any]
    ) -> tuple[Any, dict[str, Any]]:
        """Run a possibly async cell and its ancestors

        Substitutes kwargs as refs for the cell, omitting ancestors that
        whose refs are substituted.
        """
        graph = self._graph
        cell_impl = graph.cells[cell_id]
        Runner._validate_kwargs(cell_impl, kwargs)
        ancestor_ids = self._get_ancestors(cell_impl, kwargs)

        glbls: dict[str, Any] = {}
        for cid in topological_sort(graph, ancestor_ids):
            await self._executor.execute_cell_async(
                graph.cells[cid], glbls, graph
            )

        Runner._substitute_refs(cell_impl, glbls, kwargs)
        output = await self._executor.execute_cell_async(
            graph.cells[cell_impl.cell_id], glbls, graph
        )
        defs = Runner._returns(cell_impl, glbls)
        return output, defs

    def run_cell_sync(
        self, cell_id: CellId_t, kwargs: dict[str, Any]
    ) -> tuple[Any, dict[str, Any]]:
        """Run a synchronous cell and its ancestors

        Substitutes kwargs as refs for the cell, omitting ancestors that
        whose refs are substituted.

        Raises a `RuntimeError` if the cell or any of its unsubstituted
        ancestors are coroutine functions.
        """
        graph = self._graph
        cell_impl = graph.cells[cell_id]
        if cell_impl.is_coroutine():
            raise RuntimeError(
                "A coroutine function can't be run synchronously. "
                "Use `run_async()` instead"
            )

        Runner._validate_kwargs(cell_impl, kwargs)
        ancestor_ids = self._get_ancestors(cell_impl, kwargs)

        if any(graph.cells[cid].is_coroutine() for cid in ancestor_ids):
            raise RuntimeError(
                "Cell has an ancestor that is a "
                "coroutine (async) cell. Use `run_async()` instead"
            )

        glbls: dict[str, Any] = {}
        for cid in topological_sort(graph, ancestor_ids):
            self._executor.execute_cell(graph.cells[cid], glbls, graph)

        self._substitute_refs(cell_impl, glbls, kwargs)
        output = self._executor.execute_cell(
            graph.cells[cell_impl.cell_id], glbls, graph
        )
        defs = Runner._returns(cell_impl, glbls)
        return output, defs
