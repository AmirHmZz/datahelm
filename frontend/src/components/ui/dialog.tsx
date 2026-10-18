import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className={cn("dialog", wide && "dialog-wide", className)}
        >
          <div className="dialog-heading">
            <DialogPrimitive.Title className="text-lg font-semibold">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-sm text-muted-foreground mt-1">
              {description || "Review the details below."}
            </DialogPrimitive.Description>
            <DialogPrimitive.Close
              className="absolute right-5 top-5 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X size={18} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
