import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Hush "Neon" buttons (MASTER.md §4, §6): 2px-radius rectangles (never clipped, so the
// focus ring stays visible), mono uppercase labels, glow on hover.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border border-transparent font-mono text-[13px] leading-4 font-semibold tracking-[0.06em] uppercase whitespace-nowrap select-none transition-[background,border-color,box-shadow,color,transform] duration-[var(--dur-micro)] ease-hush active:not-disabled:not-aria-disabled:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-cyan text-on-cyan hover:not-disabled:not-aria-disabled:bg-cyan-hover hover:not-disabled:not-aria-disabled:shadow-glow",
        secondary:
          "border-border-strong bg-transparent text-text hover:not-disabled:not-aria-disabled:border-cyan hover:not-disabled:not-aria-disabled:text-cyan hover:not-disabled:not-aria-disabled:shadow-glow active:not-disabled:not-aria-disabled:bg-pressed",
        ghost: "bg-transparent text-text-muted hover:not-disabled:not-aria-disabled:bg-hover hover:not-disabled:not-aria-disabled:text-text",
        destructive:
          "bg-[repeating-linear-gradient(-45deg,var(--danger)_0_8px,var(--danger-2)_8px_16px)] text-on-danger hover:not-disabled:not-aria-disabled:bg-danger-2 hover:not-disabled:not-aria-disabled:shadow-[0_0_14px_rgba(224,36,58,.45)]",
        accept: "bg-online text-on-cyan hover:not-disabled:not-aria-disabled:shadow-[0_0_16px_rgba(61,255,142,.45)]",
        icon: "border-transparent bg-transparent text-text-muted hover:not-disabled:not-aria-disabled:border-edge hover:not-disabled:not-aria-disabled:bg-hover hover:not-disabled:not-aria-disabled:text-cyan active:not-disabled:not-aria-disabled:bg-pressed aria-pressed:border-queued aria-pressed:text-queued",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-[30px] px-2.5 text-xs",
        lg: "h-11 px-[18px]",
        icon: "size-9",
        "icon-lg": "size-[42px] [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
