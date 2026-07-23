import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enumerateStaticRoutes } from "../src/detect/routes.js";

const tmpDirs: string[] = [];

function makeTree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sauce-routes-"));
  tmpDirs.push(root);
  for (const f of files) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "export default () => null;\n");
  }
  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("enumerateStaticRoutes", () => {
  it("walks the app router: groups collapse, dynamic/parallel/private are set aside", () => {
    const root = makeTree([
      "app/page.tsx",
      "app/dashboard/page.tsx",
      "app/(marketing)/about/page.tsx",
      "app/orders/[id]/page.tsx",
      "app/@modal/photo/page.tsx",
      "app/_components/page.tsx",
      "app/api/route.ts",
      "app/settings/layout.tsx", // no page.tsx → not a route
    ]);
    const { routes, dynamic } = enumerateStaticRoutes(root);
    expect(routes).toEqual(["/", "/about", "/dashboard"]);
    expect(dynamic).toEqual(["/orders/[id]"]);
  });

  it("walks the pages router: index maps to parent, api and _files excluded", () => {
    const root = makeTree([
      "pages/index.tsx",
      "pages/settings.tsx",
      "pages/blog/index.tsx",
      "pages/blog/[slug].tsx",
      "pages/api/hello.ts",
      "pages/_app.tsx",
      "pages/_document.tsx",
    ]);
    const { routes, dynamic } = enumerateStaticRoutes(root);
    expect(routes).toEqual(["/", "/blog", "/settings"]);
    expect(dynamic).toEqual(["/blog/[slug]"]);
  });

  it("finds routers under src/ and dedupes across roots", () => {
    const root = makeTree(["src/app/page.tsx", "src/app/team/page.tsx"]);
    expect(enumerateStaticRoutes(root).routes).toEqual(["/", "/team"]);
  });

  it("yields nothing for a non-Next worktree", () => {
    const root = makeTree(["src/main.tsx"]);
    expect(enumerateStaticRoutes(root)).toEqual({ routes: [], dynamic: [] });
  });
});
