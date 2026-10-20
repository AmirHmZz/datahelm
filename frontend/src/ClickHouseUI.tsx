import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Empty, ErrorBox, Loading } from "./App";
export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="card mb-5">
      <div className="card-heading">
        <h2 className="card-title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Grid<T>({
  rows,
  columns,
  rowKey = (row) => JSON.stringify(row),
}: {
  rows: T[];
  columns: { label: string; render: (row: T) => ReactNode }[];
  rowKey?: (row: T) => string;
}) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.label}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="No results"
      description="No matching metadata is available on the connected server."
    />
  );
}
export function Result<T>({
  query,
  children,
}: {
  query: UseQueryResult<T, Error>;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Loading />;
  return (
    <>
      <ErrorBox error={query.error} />
      {query.data !== undefined && children(query.data)}
    </>
  );
}
