import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Input, Label } from "@tabula/ui";
import { authErrorMessage, useLogin } from "../features/auth/use-auth.ts";
import authStyles from "../features/auth/auth-layout.module.css";

export function LoginPage() {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className={authStyles.shell}>
      <div className={authStyles.brand}>Tabula</div>
      <p className={authStyles.headline}>Sign in to your workspace</p>
      <form
        className={authStyles.form}
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate({ email, password });
        }}
      >
        <div className={authStyles.field}>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className={authStyles.field}>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {login.isError ? (
          <p className={authStyles.error}>{authErrorMessage(login.error)}</p>
        ) : null}
        <Button type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className={authStyles.footer}>
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </div>
  );
}
