import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("install-github-package.ps1", () => {
  it("uses braced interpolation for scoped package strings", () => {
    const source = readFileSync(join(process.cwd(), "scripts/install-github-package.ps1"), "utf8");

    expect(source).toContain('return "${PackageName}@$script:packageVersion"');
    expect(source).toContain('return "${PackageName}@preview"');
    expect(source).toContain('return "${PackageName}@$script:defaultPackageVersion"');
    expect(source).toContain('"${PackageScope}:registry=$RegistryUrl"');
  });

  it("sets default package version placeholder once", () => {
    const source = readFileSync(join(process.cwd(), "scripts/install-github-package.ps1"), "utf8");
    const rendered = source.replace(
      "$defaultPackageVersion = ''",
      "$defaultPackageVersion = '1.2.3'",
      1,
    );

    expect(rendered).toContain("$defaultPackageVersion = '1.2.3'");
    expect(rendered.match(/\$defaultPackageVersion = ''/g)).toBeNull();
  });
});
