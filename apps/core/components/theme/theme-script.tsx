/**
 * Applies the persisted theme before React hydrates to avoid a light/dark flash.
 * Dark-first: anything other than an explicit "light" choice resolves to dark.
 * Rendered in <head> as a blocking inline script.
 */
export function ThemeScript() {
  const script = `(function(){try{var t=localStorage.getItem('theme');var d=t!=='light';document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
