import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

// Hush dialog: Radix handles focus trapping, Esc and focus return (MASTER.md §7).

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

const DialogTitle = DialogPrimitive.Title
const DialogDescription = DialogPrimitive.Description
const DialogClose = DialogPrimitive.Close

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle }
