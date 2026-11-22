// No hooks here: the root layout (a server component) renders this before anything else.

/**
 * The Shell environment's no-flash script (mobile layout spec §9.3): a classic inline script the
 * root layout puts first in `<head>`, so it runs before the first paint. It reads the global a
 * native shell injects (`window.capybaraShell`, before any page script) and marks `<html>` with
 * `data-shell`, `data-shell-platform`, `--cb-shell-inset-*` and, when the shell reports window
 * controls, `--cb-shell-controls-x|y|width|height`; with the native strip (`nav@1` an own
 * object of `capabilities`), `data-native-nav`, so the web's section entries and menu button never
 * paint beside it (the AppShell clears it when the strip goes), and `data-strip="left|right"`, the
 * strip's side: the one `nav@1.side` reports, else the side whose reported inset (rounded to
 * hundredths, as the reader does) is the larger, else right (interaction model §10.7, D16; CSS places the parts relative to the strip by it).
 *
 * A fixed string: nothing of the page, the request or the user is interpolated into it, so the
 * request's CSP nonce is the only thing that differs between documents. It does nothing outside
 * the top frame, without the global, for another envelope `version`, a global without an `on`
 * function or an unknown `kind`, and it writes only the four attributes and the eight properties
 * above, each from a value it has checked (a finite, non-negative, bounded number; a known
 * platform; an own object), whatever the global holds. `readShellEnvironment` in
 * `shell-environment.tsx` applies the same rules after hydration (the tests run both over the
 * same cases).
 */
export const SHELL_ENVIRONMENT_SCRIPT =
  "(function(){try{" +
  "var w=window;if(w!==w.top)return;" +
  "var s=w.capybaraShell;if(!s||typeof s!=='object'||s.version!==1||typeof s.on!=='function')return;" +
  "var kind=s.kind;if(kind!=='desktop'&&kind!=='mobile')return;" +
  "var platform=s.platform,insets=s.insets,controls=s.controls;" +
  "function ok(v,max){return typeof v==='number'&&v>=0&&v<=max;}" +
  "function px(v){return Math.round(v*100)/100+'px';}" +
  "var sides=['top','right','bottom','left'],names=['x','y','width','height'],ins=[],rect=null,i,v;" +
  "for(i=0;i<4;i++){v=insets&&typeof insets==='object'?insets[sides[i]]:0;" +
  "ins.push(typeof v==='number'&&v>=0&&v<Infinity?Math.min(v,512):0);}" +
  "if(controls&&typeof controls==='object'){" +
  "rect=[controls.x,controls.y,controls.width,controls.height];" +
  "if(!(ok(rect[0],16384)&&ok(rect[1],512)&&ok(rect[2],512)&&ok(rect[3],512)))rect=null;}" +
  "var d=document.documentElement,st=d.style;" +
  "d.setAttribute('data-shell',kind);" +
  "if(['macos','windows','linux','ios','android'].indexOf(platform)>=0)" +
  "d.setAttribute('data-shell-platform',platform);" +
  "for(i=0;i<4;i++)st.setProperty('--cb-shell-inset-'+sides[i],px(ins[i]));" +
  "if(rect)for(i=0;i<4;i++)st.setProperty('--cb-shell-controls-'+names[i],px(rect[i]));" +
  "var caps=s.capabilities,nav=caps&&typeof caps==='object'&&" +
  "Object.prototype.hasOwnProperty.call(caps,'nav@1')?caps['nav@1']:null;" +
  "if(nav&&typeof nav==='object'){d.setAttribute('data-native-nav','');" +
  "var side=nav.side;if(side!=='left'&&side!=='right')side=Math.round(ins[3]*100)>Math.round(ins[1]*100)?'left':'right';" +
  "d.setAttribute('data-strip',side);}" +
  "}catch(e){}})();";

/**
 * The Shell environment's inline script element, first in the root layout's `<head>`, carrying the
 * request's CSP nonce (`x-nonce`; none when the proxy did not run, and then there is no CSP). No
 * new script source is needed: the nonce admits it.
 */
export function ShellEnvironmentScript({ nonce }: { nonce?: string }) {
  return (
    <script
      nonce={nonce === undefined || nonce === "" ? undefined : nonce}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string, no page data in it
      dangerouslySetInnerHTML={{ __html: SHELL_ENVIRONMENT_SCRIPT }}
    />
  );
}
