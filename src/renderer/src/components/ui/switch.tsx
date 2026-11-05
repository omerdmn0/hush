import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

// Square HUD switch (MASTER.md §6): track 46×24, square thumb, cyan when on.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-6 w-[46px] shrink-0 items-center rounded-sm border border-border-strong bg-pressed transition-colors duration-[var(--dur-micro)] hover:not-disabled:border-cyan data-[state=checked]:border-cyan data-[state=checked]:bg-cyan-subtle disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 translate-x-[3px] bg-text-muted transition-[transform,background] duration-[var(--dur-micro)] data-[state=checked]:translate-x-[25px] data-[state=checked]:bg-cyan data-[state=checked]:shadow-glow"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
