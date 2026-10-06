import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./primitives.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  children: ReactNode;
}

export function Button({
  variant = "primary",
  className,
  children,
  ...rest
}: ButtonProps) {
  const base =
    variant === "secondary" ? styles["buttonSecondary"] : styles["button"];
  const merged = className ? `${base} ${className}` : base;
  return (
    <button type="button" className={merged} {...rest}>
      {children}
    </button>
  );
}
