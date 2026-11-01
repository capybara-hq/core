import SetupView from "./view";

/**
 * `/setup`: a server page; the layout decided on the server whether the deployment still needs its
 * first admin (and redirects to sign-in when not) and hands its answer to the view.
 */
export default function SetupPage() {
  return <SetupView />;
}
