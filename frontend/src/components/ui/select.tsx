import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn("select-trigger", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="select-chevron" size={15} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        collisionPadding={12}
        className={cn("select-content floating-panel", className)}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="select-scroll">
          <ChevronUp size={14} />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="select-viewport">
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="select-scroll">
          <ChevronDown size={14} />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn("select-item", className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="select-check">
        <Check size={14} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export type SelectOption = {
  value: string | number;
  label: string;
  disabled?: boolean;
};
const EMPTY = "__datahelm_empty_value__";

// MongoDB uses empty strings for wildcard resources and automatic mechanisms.
// Radix reserves empty values, so translate only at this presentation boundary.
export function SelectControl({
  value,
  onValueChange,
  options,
  label,
  className,
  disabled,
  placeholder = "Select…",
}: {
  value: string | number;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = React.useId();
  return (
    <Select
      value={String(value) || EMPTY}
      onValueChange={(next) => onValueChange(next === EMPTY ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={String(option.value)}
            value={String(option.value) || EMPTY}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
