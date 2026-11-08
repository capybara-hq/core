import SetupView from "./view";

/**
 * `/setup`: a server page; the layout decided on the server whether the deployment still needs its
 * first admin (and redirects to sign-in when not) and hands its answer to the view. `?error=` is
 * the error code of a native setup POST that failed (lib/form-post.ts).
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string | string[] }>;
} = {}) {
  const { error } = (await searchParams) ?? {};
  const code =
    typeof error === "string" && /^[a-z][a-z0-9_.]{0,63}$/.test(error) ? error : undefined;
  return <SetupView error={code} />;
}
