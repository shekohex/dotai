// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

export class CubeSandboxError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ApiError extends CubeSandboxError {}
export class AuthenticationError extends ApiError {}
export class SandboxNotFoundError extends ApiError {}
export class TemplateNotFoundError extends ApiError {}
