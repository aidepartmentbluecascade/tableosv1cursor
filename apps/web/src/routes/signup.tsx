import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Input, Label } from "@tabula/ui";
import { authErrorMessage, useSignup } from "../features/auth/use-auth.ts";
import authStyles from "../features/auth/auth-layout.module.css";

export function SignupPage() {
  const signup = useSignup();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className={authStyles.shell}>
      <div className={authStyles.brand}>Tabula</div>
      <p className={authStyles.headline}>Start organizing your data</p>
      <form
        className={authStyles.form}
        onSubmit={(e) => {
          e.preventDefault();
          signup.mutate({ name, email, password });
        }}
      >
        <div className={authStyles.field}>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {signup.isError ? (
          <p className={authStyles.error}>{authErrorMessage(signup.error)}</p>
        ) : null}
        <Button type="submit" disabled={signup.isPending}>
          {signup.isPending ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className={authStyles.footer}>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
