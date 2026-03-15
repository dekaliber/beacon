import { forwardRef } from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "destructive" | "ghost";
  size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        {
          "bg-primary text-primary-foreground hover:bg-primary/90": variant === "primary",
          "bg-secondary text-secondary-foreground hover:bg-secondary/80": variant === "secondary",
          "bg-destructive text-white hover:bg-destructive/90": variant === "destructive",
          "hover:bg-accent hover:text-accent-foreground": variant === "ghost",
        },
        {
          "h-8 px-3 text-xs": size === "sm",
          "h-10 px-4 text-sm": size === "md",
          "h-12 px-6 text-base": size === "lg",
        },
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
});
