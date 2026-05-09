import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("install-github-package.ps1", () => {
  it("uses braced interpolation for scoped package strings", () => {
    const source = readFileSync(join(process.cwd(), "scripts/install-github-package.ps1"), "utf8");

    expect(source).toContain('return "${PackageName}@$script:packageVersion"');
    expect(source).toContain('return "${PackageName}@preview"');
    expect(source).toContain('return "${PackageName}@$script:defaultPackageVersion"');
    expect(source).toContain('return "${PackageName}@$resolvedPackageVersion"');
    expect(source).toContain('"${PackageScope}:registry=$RegistryUrl"');
  });

  it("invokes package managers with argument arrays", () => {
    const source = readFileSync(join(process.cwd(), "scripts/install-github-package.ps1"), "utf8");

    expect(source).toContain(
      "$npmArguments = @('install', '--global', $packageReference, '--userconfig', (Join-Path $tempDirectory '.npmrc'))",
    );
    expect(source).toContain("npm @npmArguments");
    expect(source).toContain("$pnpmArguments = @('add', '--global', $packageReference)");
    expect(source).toContain("pnpm @pnpmArguments");
  });

  it("emits verbose debug notes for command execution", () => {
    const source = readFileSync(join(process.cwd(), "scripts/install-github-package.ps1"), "utf8");

    expect(source).toContain("function Debug-Note {");
    expect(source).toContain('Debug-Note "selected package manager=$script:packageManager"');
    expect(source).toContain('Debug-Note "package reference=$packageReference"');
    expect(source).toContain(
      'Debug-Note "resolved package version from metadata=$resolvedPackageVersion"',
    );
    expect(source).toContain("Debug-Note \"command=npm $(\$npmArguments -join ' ')\"");
  });

  it("resolves default version from registry metadata", () => {
    const source = readFileSync(join(process.cwd(), "scripts/install-github-package.ps1"), "utf8");

    expect(source).toContain("function Resolve-DefaultPackageVersionFromMetadata {");
    expect(source).toContain("$parsedMetadata.'dist-tags'.latest");
    expect(source).toContain("$parsedMetadata.'dist-tags'.preview");
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
