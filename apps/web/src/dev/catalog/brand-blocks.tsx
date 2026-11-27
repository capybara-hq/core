"use client";

import {
  AuthPage,
  Button,
  Card,
  EmptyState,
  Field,
  Greeting,
  Input,
  Stack,
  StatusPage,
  Text,
  WorkingLine,
} from "@capybara-hq/design";
import { FIXTURE_BRAND } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { BrandRoot } from "../../components/design-root";
import { FixtureShell } from "./frame";
import { RefBlock } from "./ref-block";

/** Draws `children` with the fixture theme's brand (data-URI mark and illustration). */
export function FixtureBrand({ children }: { children: ReactNode }) {
  return <BrandRoot brand={FIXTURE_BRAND}>{children}</BrandRoot>;
}

/**
 * `/dev/ui/brand/fixture` (theme brand coverage spec §3, visual cases): every graphic a theme's
 * brand replaces, drawn with the fixture brand under the built-in tokens (theme tokens are the e2e
 * suite's): the empty state as a page and in a panel, the greeting and the working line (still),
 * the sign-in page without its decoration and the 404 page in the shell.
 */
export function BrandFixtureCatalog() {
  return (
    <FixtureBrand>
      <Stack gap={24}>
        <Text variant="h1">Brand fixture</Text>
        <EmptyState text="还没有智能体" hint="创建一个智能体开始" />
        <Card title="连接器">
          <EmptyState text="还没有连接器" size="panel" />
        </Card>
        <Greeting text="下午好，grant" still />
        <WorkingLine still />
        <AuthPage title="登录" subtitle="示例组织">
          <Stack gap={16}>
            <Field label="账号">
              <Input defaultValue="grant" />
            </Field>
            <Button variant="primary" density="prominent">
              登录
            </Button>
          </Stack>
        </AuthPage>
        <FixtureShell nav="">
          <StatusPage
            header={{ path: [{ label: "~" }], title: "页面不存在" }}
            kind="404"
            title="页面不存在"
            description="链接可能已失效，或该智能体已被删除。"
            action={<Button variant="primary">返回概览</Button>}
          />
        </FixtureShell>
      </Stack>
    </FixtureBrand>
  );
}

/** The empty state's theme-art states (spec §6.18), 752 wide with the reference's padding. */
function emptyStateBlocks(): ReactNode {
  return (
    <FixtureBrand>
      <RefBlock id="empty-state-branded-page" width={752} pad>
        <EmptyState text="还没有智能体" hint="创建一个智能体开始" />
      </RefBlock>
      <RefBlock id="empty-state-branded-panel" width={400} pad>
        <EmptyState text="还没有连接器" size="panel" />
      </RefBlock>
    </FixtureBrand>
  );
}

export const BRAND_REFERENCE_BLOCKS = {
  "empty-state": emptyStateBlocks,
} as const;
