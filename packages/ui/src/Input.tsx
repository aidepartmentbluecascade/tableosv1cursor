import type { InputHTMLAttributes } from "react";
import styles from "./primitives.module.css";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: InputProps) {
  const merged = className ? `${styles["input"]} ${className}` : styles["input"];
  return <input className={merged} {...rest} />;
}
