import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({
  className,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={cn("popover-content floating-panel", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
