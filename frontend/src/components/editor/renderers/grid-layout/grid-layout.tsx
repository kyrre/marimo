/* Copyright 2024 Marimo. All rights reserved. */
import React, {
  memo,
  type PropsWithChildren,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Responsive, WidthProvider } from "react-grid-layout";
import { OutputArea } from "@/components/editor/Output";
import type { CellRuntimeState } from "@/core/cells/types";
import type { ICellRendererProps } from "../types";
import type { GridLayout, GridLayoutCellSide } from "./types";

import "react-grid-layout/css/styles.css";
import "./styles.css";
import { BorderAllIcon } from "@radix-ui/react-icons";
import { startCase } from "lodash-es";
import {
  AlignEndVerticalIcon,
  AlignHorizontalSpaceAroundIcon,
  AlignStartVerticalIcon,
  CheckIcon,
  GripHorizontalIcon,
  LockIcon,
  ScrollIcon,
  XIcon,
} from "lucide-react";
import { TinyCode } from "@/components/editor/cell/TinyCode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { outputIsLoading } from "@/core/cells/cell";
import type { CellId } from "@/core/cells/ids";
import type { AppMode } from "@/core/mode";
import { useIsDragging } from "@/hooks/useIsDragging";
import { cn } from "@/utils/cn";
import { Maps } from "@/utils/maps";
import { Objects } from "@/utils/objects";

type Props = ICellRendererProps<GridLayout>;

const ReactGridLayout = WidthProvider(Responsive);

const MARGIN: [number, number] = [0, 0];

const DRAG_HANDLE = "grid-drag-handle";

export const GridLayoutRenderer: React.FC<Props> = ({
  layout,
  setLayout,
  cells,
  mode,
}) => {
  const isReading = mode === "read";
  const inGridIds = new Set(layout.cells.map((cell) => cell.i));
  const [droppingItem, setDroppingItem] = useState<{
    i: string;
    w?: number;
    h?: number;
  } | null>(null);
  const [isLocked, setIsLocked] = useState(false);

  const cols = useMemo(
    () => ({
      // we only allow 1 responsive breakpoint
      // we can change this later if we want to support more,
      // but this increases complexity to the user
      lg: layout.columns,
    }),
    [layout.columns],
  );

  // Add class to update the background of the app
  useEffect(() => {
    const appEl = document.getElementById("App");
    if (layout.bordered) {
      appEl?.classList.add("grid-bordered");
    } else {
      appEl?.classList.remove("grid-bordered");
    }

    return () => {
      appEl?.classList.remove("grid-bordered");
    };
  }, [layout.bordered]);

  const { isDragging, ...dragProps } = useIsDragging();

  const enableInteractions = !isReading && !isLocked;
  const layoutByCellId = Maps.keyBy(layout.cells, (cell) => cell.i);

  const handleMakeScrollable = (cellId: CellId) => (isScrollable: boolean) => {
    const scrollableCells = new Set(layout.scrollableCells);
    if (isScrollable) {
      scrollableCells.add(cellId);
    } else {
      scrollableCells.delete(cellId);
    }
    setLayout({
      ...layout,
      scrollableCells: scrollableCells,
    });
  };

  const handleSetSide = (cellId: CellId) => (side: GridLayoutCellSide) => {
    const cellSide = new Map(layout.cellSide);
    if (side === cellSide.get(cellId)) {
      cellSide.delete(cellId);
    } else {
      cellSide.set(cellId, side);
    }
    setLayout({
      ...layout,
      cellSide: cellSide,
    });
  };

  const styles: React.CSSProperties = {};
  // Max width styles
  if (layout.maxWidth) {
    styles.maxWidth = `${layout.maxWidth}px`;
  }
  // Editing background styles
  if (enableInteractions) {
    styles.backgroundImage =
      "repeating-linear-gradient(var(--gray-4) 0 1px, transparent 1px 100%), repeating-linear-gradient(90deg, var(--gray-4) 0 1px, transparent 1px 100%)";
    styles.backgroundSize = `calc((100% / ${layout.columns})) ${layout.rowHeight}px`;
  }

  let grid = (
    <ReactGridLayout
      breakpoint="lg"
      layouts={{
        lg: layout.cells,
      }}
      style={styles}
      cols={cols}
      allowOverlap={false}
      className={cn(
        "w-full mx-auto bg-background flex-1 min-h-full",
        // Show grid border and background when editing
        enableInteractions && "bg-[var(--slate-2)] border-r",
        // Disable animations and add padding when reading
        isReading && "disable-animation",
        !layout.maxWidth && "min-w-[800px]",
      )}
      // Add additional padding if bordered when reading
      containerPadding={isReading ? [20, 20] : undefined}
      margin={MARGIN}
      isBounded={false}
      compactType={null}
      preventCollision={true}
      rowHeight={layout.rowHeight}
      onLayoutChange={(cellLayouts) =>
        setLayout({
          ...layout,
          cells: cellLayouts,
        })
      }
      droppingItem={
        droppingItem
          ? {
              i: droppingItem.i,
              w: droppingItem.w || 2,
              h: droppingItem.h || 2,
            }
          : undefined
      }
      onDrop={(cellLayouts, dropped, _event) => {
        dragProps.onDragStop();
        if (!dropped) {
          return;
        }
        setLayout({
          ...layout,
          cells: [...cellLayouts, dropped],
        });
      }}
      onDragStart={(_layout, _oldItem, _newItem, _placeholder, event) => {
        dragProps.onDragStart(event);
      }}
      onDrag={(_layout, _oldItem, _newItem, _placeholder, event) => {
        dragProps.onDragMove(event);
      }}
      onDragStop={() => {
        dragProps.onDragStop();
      }}
      onResizeStop={() => {
        // Dispatch a resize event so widgets know to resize
        window.dispatchEvent(new Event("resize"));
      }}
      // When in read mode or locked, disable dragging and resizing
      isDraggable={enableInteractions}
      isDroppable={enableInteractions}
      isResizable={enableInteractions}
      draggableHandle={enableInteractions ? `.${DRAG_HANDLE}` : "noop"}
    >
      {cells
        .filter((cell) => inGridIds.has(cell.id))
        .map((cell) => {
          const cellLayout = layoutByCellId.get(cell.id);
          const isScrollable = layout.scrollableCells.has(cell.id) ?? false;
          const side = layout.cellSide.get(cell.id);
          const gridCell = (
            <GridCell
              code={cell.code}
              mode={mode}
              cellId={cell.id}
              output={cell.output}
              status={cell.status}
              isScrollable={isScrollable}
              side={side}
              hidden={cell.errored || cell.interrupted || cell.stopped}
            />
          );

          if (enableInteractions) {
            return (
              <EditableGridCell
                key={cell.id}
                id={cell.id}
                isDragging={isDragging}
                side={side}
                setSide={handleSetSide(cell.id)}
                isScrollable={isScrollable}
                setIsScrollable={handleMakeScrollable(cell.id)}
                display={cellLayout?.y === 0 ? "bottom" : "top"}
                onDelete={() => {
                  setLayout({
                    ...layout,
                    cells: layout.cells.filter((c) => c.i !== cell.id),
                  });
                }}
              >
                {gridCell}
              </EditableGridCell>
            );
          }

          return <div key={cell.id}>{gridCell}</div>;
        })}
    </ReactGridLayout>
  );

  if (isReading) {
    if (layout.bordered) {
      grid = (
        <div className="flex flex-1 flex-col items-center">
          <div
            style={styles}
            className="bg-background flex-1 border-t border-x rounded-t shadow-sm w-full overflow-hidden"
          >
            {grid}
          </div>
        </div>
      );
    }
    return grid;
  }

  const notInGrid = cells.filter((cell) => !inGridIds.has(cell.id));

  if (layout.bordered) {
    grid = (
      <div
        style={styles}
        className="bg-background border-t border-x rounded-t shadow-sm w-full mx-auto mt-4 h-[calc(100%-1rem)] overflow-hidden"
      >
        <div className="h-full overflow-auto">{grid}</div>
      </div>
    );
  }

  return (
    <>
      <GridControls
        layout={layout}
        setLayout={setLayout}
        isLocked={isLocked}
        setIsLocked={setIsLocked}
      />
      <div className={cn("relative flex z-10 flex-1 overflow-hidden")}>
        <div
          className={cn(
            "flex-grow overflow-auto transparent-when-disconnected",
          )}
        >
          {grid}
        </div>
        <div className="flex-none flex flex-col w-[300px] p-2 pb-20 gap-2 overflow-auto bg-[var(--slate-2)] border-t border-x rounded-t shadow-sm transparent-when-disconnected mx-2 mt-4">
          <div className="text font-bold text-[var(--slate-20)] flex-shrink-0">
            Outputs
          </div>
          {notInGrid.map((cell) => (
            <div
              key={cell.id}
              draggable={true}
              // eslint-disable-next-line react/no-unknown-property
              unselectable="on"
              data-cell-id={cell.id}
              // Firefox requires some kind of initialization which we can do by adding this attribute
              // @see https://bugzilla.mozilla.org/show_bug.cgi?id=568313
              onDragStart={(e) => {
                // get height of self
                const height = e.currentTarget.offsetHeight;

                setDroppingItem({
                  i: cell.id,
                  w: layout.columns / 4,
                  h: Math.ceil(height / layout.rowHeight) || 1,
                });
                e.dataTransfer.setData("text/plain", "");
              }}
              className={cn(
                DRAG_HANDLE,
                "droppable-element bg-background border-border border overflow-hidden p-2 rounded flex-shrink-0",
              )}
            >
              <GridCell
                code={cell.code}
                className="select-none pointer-events-none"
                mode={mode}
                cellId={cell.id}
                output={cell.output}
                isScrollable={false}
                status={cell.status}
                hidden={false}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

interface GridCellProps extends Pick<CellRuntimeState, "output" | "status"> {
  className?: string;
  code: string;
  cellId: CellId;
  mode: AppMode;
  hidden: boolean;
  isScrollable: boolean;
  side?: GridLayoutCellSide;
}

const GridCell = memo(
  ({
    output,
    cellId,
    status,
    mode,
    code,
    hidden,
    isScrollable,
    side,
    className,
  }: GridCellProps) => {
    const loading = outputIsLoading(status);

    const isOutputEmpty = output == null || output.data === "";
    // If not reading, show code when there is no output
    if (isOutputEmpty && mode !== "read") {
      return <TinyCode className={className} code={code} />;
    }

    return (
      <div
        className={cn(
          className,
          "h-full w-full p-2 overflow-x-auto",
          hidden && "invisible",
          isScrollable ? "overflow-y-auto" : "overflow-y-hidden",
          side === "top" && "flex items-start",
          side === "bottom" && "flex items-end",
          side === "left" && "flex justify-start",
          side === "right" && "flex justify-end",
        )}
      >
        <OutputArea
          allowExpand={false}
          output={output}
          cellId={cellId}
          stale={loading}
          loading={loading}
        />
      </div>
    );
  },
);
GridCell.displayName = "GridCell";

const GridControls: React.FC<{
  layout: GridLayout;
  setLayout: (layout: GridLayout) => void;
  isLocked: boolean;
  setIsLocked: (isLocked: boolean) => void;
}> = ({ layout, setLayout, isLocked, setIsLocked }) => {
  return (
    <div className="flex flex-row absolute pl-5 top-8 gap-4 w-full justify-end pr-[350px] pb-3 border-b z-50">
      <div className="flex flex-row items-center gap-2">
        <Label htmlFor="columns">Columns</Label>
        <NumberField
          data-testid="grid-columns-input"
          id="columns"
          value={layout.columns}
          className="w-[60px]"
          placeholder="# of Columns"
          minValue={1}
          onChange={(valueAsNumber) => {
            setLayout({
              ...layout,
              columns: valueAsNumber,
            });
          }}
        />
      </div>
      <div className="flex flex-row items-center gap-2">
        <Label htmlFor="rowHeight">Row Height (px)</Label>
        <NumberField
          data-testid="grid-row-height-input"
          id="rowHeight"
          value={layout.rowHeight}
          className="w-[60px]"
          placeholder="Row Height (px)"
          minValue={1}
          onChange={(valueAsNumber) => {
            setLayout({
              ...layout,
              rowHeight: valueAsNumber,
            });
          }}
        />
      </div>
      <div className="flex flex-row items-center gap-2">
        <Label htmlFor="maxWidth">Max Width (px)</Label>
        <NumberField
          data-testid="grid-max-width-input"
          id="maxWidth"
          value={layout.maxWidth}
          className="w-[90px]"
          step={100}
          placeholder="Full"
          onChange={(valueAsNumber) => {
            setLayout({
              ...layout,
              maxWidth: Number.isNaN(valueAsNumber) ? undefined : valueAsNumber,
            });
          }}
        />
      </div>
      <div className="flex flex-row items-center gap-2">
        <Label className="flex flex-row items-center gap-1" htmlFor="lock">
          <BorderAllIcon className="h-3 w-3" />
          Bordered
        </Label>
        <Switch
          data-testid="grid-bordered-switch"
          id="lock"
          checked={layout.bordered}
          size="sm"
          onCheckedChange={(bordered) => {
            setLayout({
              ...layout,
              bordered,
            });
          }}
        />
      </div>
      <div className="flex flex-row items-center gap-2">
        <Label className="flex flex-row items-center gap-1" htmlFor="lock">
          <LockIcon className="h-3 w-3" />
          Lock Grid
        </Label>
        <Switch
          data-testid="grid-lock-switch"
          id="lock"
          checked={isLocked}
          size="sm"
          onCheckedChange={setIsLocked}
        />
      </div>
    </div>
  );
};

const EditableGridCell = React.forwardRef(
  (
    {
      children,
      isDragging,
      className,
      onDelete,
      isScrollable,
      setIsScrollable,
      side,
      setSide,
      display,
      ...rest
    }: PropsWithChildren<{
      id: CellId;
      className?: string;
      isDragging: boolean;

      onDelete: () => void;

      isScrollable: boolean;
      setIsScrollable: (isScrollable: boolean) => void;

      side?: GridLayoutCellSide;
      setSide: (side: GridLayoutCellSide) => void;

      display: "top" | "bottom";
    }>,
    ref: React.Ref<HTMLDivElement>,
  ) => {
    const [popoverOpened, setPopoverOpened] = useState<"side" | "scroll">();

    return (
      <div
        ref={ref}
        {...rest}
        className={cn(
          className,
          "relative z-10 hover:z-20",
          "bg-background border-transparent hover:border-[var(--sky-8)] border",
          popoverOpened && "border-[var(--sky-8)] z-20",
          !popoverOpened && "hover-actions-parent",
          isDragging && "bg-[var(--slate-2)] border-border z-20",
        )}
      >
        {children}
        <GridHoverActions
          onDelete={onDelete}
          isScrollable={isScrollable}
          setIsScrollable={setIsScrollable}
          side={side}
          setSide={setSide}
          display={display}
          setPopoverOpened={setPopoverOpened}
          popoverOpened={popoverOpened}
        />
      </div>
    );
  },
);
EditableGridCell.displayName = "EditableGridCell";

interface GridHoverActionsProps {
  onDelete: () => void;

  isScrollable: boolean;
  setIsScrollable: (isScrollable: boolean) => void;

  side?: GridLayoutCellSide;
  setSide: (side: GridLayoutCellSide) => void;

  display: "top" | "bottom";

  popoverOpened: "side" | "scroll" | undefined;
  setPopoverOpened: (popoverOpened: "side" | "scroll" | undefined) => void;
}

const GridHoverActions: React.FC<GridHoverActionsProps> = ({
  display,
  onDelete,
  side,
  setSide,
  isScrollable,
  setIsScrollable,
  popoverOpened,
  setPopoverOpened,
}) => {
  const buttonClassName = "h-4 w-4 opacity-60 hover:opacity-100";
  const SideIcon =
    side === "left"
      ? AlignStartVerticalIcon
      : side === "right"
        ? AlignEndVerticalIcon
        : undefined;

  return (
    <div
      className={cn(
        "absolute right-0 p-1 bg-[var(--sky-8)] text-white h-6 z-10 flex gap-2",
        !popoverOpened && "hover-action",
        display === "top" && "-top-6 rounded-t",
        display === "bottom" && "-bottom-6 rounded-b",
      )}
    >
      <DropdownMenu
        open={popoverOpened === "side"}
        onOpenChange={(open) => setPopoverOpened(open ? "side" : undefined)}
      >
        <DropdownMenuTrigger asChild={true}>
          {SideIcon ? (
            <SideIcon className={buttonClassName} />
          ) : (
            <AlignHorizontalSpaceAroundIcon className={buttonClassName} />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom">
          {Objects.entries(SIDE_TO_ICON).map(([option, Icon]) => (
            <DropdownMenuItem key={option} onSelect={() => setSide(option)}>
              <Icon className={"h-4 w-3 mr-2"} />
              <span className="flex-1">{startCase(option)}</span>
              {option === side && <CheckIcon className="h-4 w-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu
        open={popoverOpened === "scroll"}
        onOpenChange={(open) => setPopoverOpened(open ? "scroll" : undefined)}
      >
        <DropdownMenuTrigger asChild={true}>
          <ScrollIcon className={buttonClassName} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom">
          <DropdownMenuItem onSelect={() => setIsScrollable(!isScrollable)}>
            <span className="flex-1">Scrollable</span>
            <Switch
              data-testid="grid-scrollable-switch"
              checked={isScrollable}
              size="sm"
              onCheckedChange={setIsScrollable}
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <GripHorizontalIcon
        className={cn(DRAG_HANDLE, "cursor-move", buttonClassName)}
      />
      <XIcon className={buttonClassName} onClick={() => onDelete()} />
    </div>
  );
};

const SIDE_TO_ICON = {
  // We are only showing horizontal sides for now
  // top: AlignHorizontalSpaceAroundIcon,
  // bottom: AlignHorizontalSpaceAroundIcon,
  left: AlignStartVerticalIcon,
  right: AlignEndVerticalIcon,
};
