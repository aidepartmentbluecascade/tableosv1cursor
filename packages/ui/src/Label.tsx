import type { LabelHTMLAttributes, ReactNode } from "react";
import styles from "./primitives.module.css";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
}

export function Label({ className, children, ...rest }: LabelProps) {
  const merged = className ? `${styles["label"]} ${className}` : styles["label"];
  return (
    <label className={merged} {...rest}>
      {children}
    </label>
  );
}
