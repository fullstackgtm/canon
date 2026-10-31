"use client";

import { KeyboardEvent, ReactNode, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  evaluateSpreadsheetFormula,
  formatFormulaResult,
  isFormulaValue,
  type FormulaContext,
} from "@/lib/spreadsheet";

type EditableValue = string | number | null | undefined;

export type EditableGridColumn<T> = {
  key: string;
  header: string;
  inputType?: "text" | "number";
  placeholder?: string;
  className?: string;
  align?: "left" | "right";
  readOnly?: boolean;
  allowFormula?: boolean;
  formulaAliases?: string[];
  getValue?: (row: T) => EditableValue;
  render?: (row: T) => ReactNode;
};

type EditableGridProps<T> = {
  columns: EditableGridColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onCellCommit: (row: T, columnKey: string, value: string) => void | Promise<void>;
  onAddRow?: () => void;
  addRowLabel?: string;
  footer?: ReactNode;
  className?: string;
};

export function EditableGrid<T>({
  columns,
  rows,
  rowKey,
  onCellCommit,
  onAddRow,
  addRowLabel = "Add row",
  footer,
  className,
}: EditableGridProps<T>) {
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const editableColumns = useMemo(
    () => columns.filter((column) => !column.readOnly),
    [columns],
  );

  function inputKey(rowIndex: number, columnKey: string) {
    return `${rowIndex}:${columnKey}`;
  }

  function formulaContext(row: T, overrides: FormulaContext = {}): FormulaContext {
    const context: FormulaContext = {};
    columns.forEach((column) => {
      writeFormulaAliases(context, column, column.getValue?.(row) ?? "");
    });
    Object.assign(context, overrides);
    return context;
  }

  function cellCommitValue(
    rawValue: string,
    row: T,
    column: EditableGridColumn<T>,
    contextOverrides?: FormulaContext,
  ) {
    let value = rawValue;

    if (allowsFormula(column) && isFormulaValue(value)) {
      try {
        value = formatFormulaResult(
          evaluateSpreadsheetFormula(value, formulaContext(row, contextOverrides)),
        );
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : "Invalid formula",
        };
      }
    }

    return { ok: true as const, value };
  }

  function commitCell(
    input: HTMLInputElement,
    row: T,
    column: EditableGridColumn<T>,
  ) {
    const result = cellCommitValue(input.value, row, column);
    if (!result.ok) {
      input.setCustomValidity(result.error);
      input.reportValidity();
      return false;
    }

    const value = result.value;
    input.value = value;
    input.setCustomValidity("");
    void onCellCommit(row, column.key, value);
    return true;
  }

  function focusCell(rowIndex: number, editableColumnIndex: number) {
    const boundedRowIndex = Math.max(0, Math.min(rowIndex, rows.length - 1));
    const boundedColumnIndex = Math.max(
      0,
      Math.min(editableColumnIndex, editableColumns.length - 1),
    );
    const column = editableColumns[boundedColumnIndex];
    if (!column) return;

    window.requestAnimationFrame(() => {
      const input = inputRefs.current.get(inputKey(boundedRowIndex, column.key));
      input?.focus();
      input?.select();
    });
  }

  function moveFocus(
    rowIndex: number,
    editableColumnIndex: number,
    direction: 1 | -1,
  ) {
    if (rows.length === 0 || editableColumns.length === 0) return;

    let nextRowIndex = rowIndex;
    let nextColumnIndex = editableColumnIndex + direction;

    if (nextColumnIndex >= editableColumns.length) {
      nextColumnIndex = 0;
      nextRowIndex = Math.min(rowIndex + 1, rows.length - 1);
    }

    if (nextColumnIndex < 0) {
      nextColumnIndex = editableColumns.length - 1;
      nextRowIndex = Math.max(rowIndex - 1, 0);
    }

    focusCell(nextRowIndex, nextColumnIndex);
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    row: T,
    rowIndex: number,
    column: EditableGridColumn<T>,
    editableColumnIndex: number,
  ) {
    if (event.key !== "Tab" && event.key !== "Enter") return;

    event.preventDefault();
    const committed = commitCell(event.currentTarget, row, column);
    if (!committed) return;

    if (event.key === "Enter") {
      focusCell(Math.min(rowIndex + 1, rows.length - 1), editableColumnIndex);
      return;
    }

    moveFocus(rowIndex, editableColumnIndex, event.shiftKey ? -1 : 1);
  }

  function handlePaste(
    event: React.ClipboardEvent<HTMLInputElement>,
    rowIndex: number,
    editableColumnIndex: number,
  ) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\t") && !text.includes("\n")) return;

    event.preventDefault();
    const pastedRows = parsePastedGrid(text);
    if (pastedRows.length === 0) return;

    const commits: Promise<unknown>[] = [];
    const contextOverridesByRow = new Map<number, FormulaContext>();
    let lastFocusedRow = rowIndex;
    let lastFocusedColumn = editableColumnIndex;

    for (const [pastedRowOffset, pastedRow] of pastedRows.entries()) {
      const targetRowIndex = rowIndex + pastedRowOffset;
      const targetRow = rows[targetRowIndex];
      if (!targetRow) continue;

      let rowOverrides = contextOverridesByRow.get(targetRowIndex);
      if (!rowOverrides) {
        rowOverrides = {};
        contextOverridesByRow.set(targetRowIndex, rowOverrides);
      }

      for (const [pastedColumnOffset, rawValue] of pastedRow.entries()) {
        const targetColumnIndex = editableColumnIndex + pastedColumnOffset;
        const targetColumn = editableColumns[targetColumnIndex];
        if (!targetColumn) continue;

        const result = cellCommitValue(
          rawValue,
          targetRow,
          targetColumn,
          rowOverrides,
        );
        if (!result.ok) {
          event.currentTarget.setCustomValidity(result.error);
          event.currentTarget.reportValidity();
          return;
        }

        const value = result.value;
        writeFormulaAliases(rowOverrides, targetColumn, value);

        const input = inputRefs.current.get(
          inputKey(targetRowIndex, targetColumn.key),
        );
        if (input) {
          input.value = value;
          input.setCustomValidity("");
        }

        commits.push(Promise.resolve(onCellCommit(targetRow, targetColumn.key, value)));
        lastFocusedRow = targetRowIndex;
        lastFocusedColumn = targetColumnIndex;
      }
    }

    event.currentTarget.setCustomValidity("");
    void Promise.all(commits).catch((error) => {
      console.error("Failed to commit pasted grid values", error);
    });
    focusCell(lastFocusedRow, lastFocusedColumn);
  }

  return (
    <div className={cn("overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border/70">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    "px-3 py-2.5 text-left font-medium text-muted-foreground",
                    column.align === "right" && "text-right",
                    column.className,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, rowIndex) => (
              <tr key={rowKey(row)} className="transition-colors hover:bg-muted/30">
                {columns.map((column) => {
                  const editableColumnIndex = editableColumns.findIndex(
                    (candidate) => candidate.key === column.key,
                  );
                  const value = column.getValue?.(row) ?? "";

                  return (
                    <td
                      key={column.key}
                      className={cn(
                        "px-3 py-2",
                        column.align === "right" && "text-right",
                        column.className,
                      )}
                    >
                      {column.readOnly ? (
                        column.render ? (
                          column.render(row)
                        ) : (
                          <span>{String(value ?? "")}</span>
                        )
                      ) : (
                        <input
                          key={`${rowKey(row)}:${column.key}:${String(value ?? "")}`}
                          ref={(input) => {
                            const key = inputKey(rowIndex, column.key);
                            if (input) inputRefs.current.set(key, input);
                            else inputRefs.current.delete(key);
                          }}
                          defaultValue={value ?? ""}
                          type={inputTypeForColumn(column)}
                          inputMode={
                            column.inputType === "number" ? "decimal" : undefined
                          }
                          min={
                            inputTypeForColumn(column) === "number" ? "0" : undefined
                          }
                          step={
                            inputTypeForColumn(column) === "number"
                              ? "0.01"
                              : undefined
                          }
                          placeholder={column.placeholder}
                          aria-label={`${column.header} for row ${rowIndex + 1}`}
                          title={
                            allowsFormula(column)
                              ? "Use = to enter formulas"
                              : undefined
                          }
                          onBlur={(event) =>
                            void commitCell(event.target, row, column)
                          }
                          onPaste={(event) =>
                            handlePaste(event, rowIndex, editableColumnIndex)
                          }
                          onKeyDown={(event) =>
                            handleKeyDown(
                              event,
                              row,
                              rowIndex,
                              column,
                              editableColumnIndex,
                            )
                          }
                          className={cn(
                            "h-8 w-full rounded-md border border-transparent bg-transparent px-2 text-sm outline-none transition-colors hover:border-border focus:border-primary focus:bg-background",
                            column.align === "right" && "text-right tabular-nums",
                          )}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      {onAddRow && (
        <div className="border-t border-border bg-card p-2">
          <button
            type="button"
            onClick={onAddRow}
            className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
            {addRowLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function allowsFormula<T>(column: EditableGridColumn<T>) {
  return column.allowFormula ?? column.inputType === "number";
}

function inputTypeForColumn<T>(column: EditableGridColumn<T>) {
  if (allowsFormula(column)) return "text";
  return column.inputType ?? "text";
}

function parsePastedGrid(text: string) {
  const rows = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((row) => row.split("\t"));
}

function writeFormulaAliases<T>(
  context: FormulaContext,
  column: EditableGridColumn<T>,
  value: EditableValue,
) {
  formulaAliases(column).forEach((alias) => {
    context[alias] = value;
  });
}

function formulaAliases<T>(column: EditableGridColumn<T>) {
  const aliases = new Set<string>();
  const candidates = [column.key, column.header, ...(column.formulaAliases ?? [])];

  candidates.forEach((candidate) => {
    identifierVariants(candidate).forEach((alias) => aliases.add(alias));
  });

  return [...aliases];
}

function identifierVariants(value: string) {
  const variants = new Set<string>();
  const trimmed = value.trim();
  if (isFormulaIdentifier(trimmed)) variants.add(trimmed);

  const words = trimmed.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length > 0) {
    variants.add(words.join(""));
    variants.add(words.map((word) => word.toLowerCase()).join("_"));
    variants.add(toCamelCase(words));
  }

  return [...variants].filter(isFormulaIdentifier);
}

function toCamelCase(words: string[]) {
  const [first, ...rest] = words;
  return [
    first.toLowerCase(),
    ...rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()),
  ].join("");
}

function isFormulaIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value);
}
