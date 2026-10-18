export type Locale = "zh" | "en";

const zh = {
  "theme.dark": "深色",
  "theme.light": "浅色",
  "theme.toggle": "切换主题",
  "field.reset": "↺ 恢复默认",
  "field.optional": "可选",
  "stepper.decrease": "减少",
  "stepper.increase": "增加",
  "status.running": "运行中",
  "status.success": "成功",
  "status.failed": "失败",
  "status.waiting": "待审批",
  "status.queued": "排队",
  "status.cancelled": "已取消",
  "pagination.prev": "上一页",
  "pagination.next": "下一页",
  "pagination.perPage": "每页",
  "pagination.label": "分页",
};

export type DesignKey = keyof typeof zh;

const en: Record<DesignKey, string> = {
  "theme.dark": "Dark",
  "theme.light": "Light",
  "theme.toggle": "Toggle theme",
  "field.reset": "↺ Reset to default",
  "field.optional": "optional",
  "stepper.decrease": "Decrease",
  "stepper.increase": "Increase",
  "status.running": "Running",
  "status.success": "Success",
  "status.failed": "Failed",
  "status.waiting": "Awaiting approval",
  "status.queued": "Queued",
  "status.cancelled": "Cancelled",
  "pagination.prev": "Previous",
  "pagination.next": "Next",
  "pagination.perPage": "Per page",
  "pagination.label": "Pagination",
};

export const messages: Record<Locale, Record<DesignKey, string>> = { zh, en };
