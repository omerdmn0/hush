import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm border border-border-strong bg-sunken px-3 text-sm font-medium text-text transition-[border-color,box-shadow] duration-[var(--dur-micro)] outline-none placeholder:text-text-muted hover:not-disabled:border-text-muted focus-visible:border-cyan focus-visible:shadow-[0_0_0_1px_var(--cyan),var(--glow)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger-text aria-invalid:focus-visible:shadow-[0_0_0_1px_var(--danger-text)] read-only:focus-visible:shadow-[0_0_0_1px_var(--cyan)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
