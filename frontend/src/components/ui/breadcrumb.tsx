import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export function Breadcrumb({
  ...props
}: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" {...props} />;
}

export function BreadcrumbList({
  className,
  ...props
}: React.ComponentProps<"ol">) {
  return <ol className={cn("breadcrumb-list", className)} {...props} />;
}

export function BreadcrumbItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return <li className={cn("breadcrumb-item", className)} {...props} />;
}

export function BreadcrumbLink({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "a";
  return <Comp className={cn("breadcrumb-link", className)} {...props} />;
}

export function BreadcrumbPage({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("breadcrumb-page", className)}
      {...props}
    />
  );
}

export function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      role="presentation"
      aria-hidden="true"
      className={cn("breadcrumb-separator", className)}
      {...props}
    >
      {children ?? <ChevronRight size={12} />}
    </li>
  );
}
