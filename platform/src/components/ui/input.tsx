import { cn } from "@/lib/utils";
import { forwardRef } from "react";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-line bg-raised px-3 text-sm",
        "placeholder:text-faint focus:border-phosphor/50 focus:outline-none transition-colors",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-md border border-line bg-raised px-3 py-2 text-sm",
        "placeholder:text-faint focus:border-phosphor/50 focus:outline-none transition-colors resize-none",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
