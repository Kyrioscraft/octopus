import { theme as antdTheme } from "antd";
import type { ThemeConfig } from "antd";

/**
 * antd theme, kept in step with the CSS tokens in `styles/theme.css`.
 *
 * The two systems are complementary: `theme.css` owns everything we style by hand
 * (surfaces, our own rows/rails/pills), while antd's tokens govern the components
 * we borrow. Values therefore intentionally duplicate the CSS variables — antd
 * derives hover/active/outline shades arithmetically from `colorPrimary` and needs
 * literal colors, not `var()` references.
 *
 * Rule of thumb when editing: colours here must equal the same-named semantic token
 * in theme.css for that mode. In particular `colorPrimary` == `--main-600` ==
 * `--accent-solid`, so antd buttons and our hand-rolled accents are the same green.
 */

const FONT_SANS = [
  '"Inter"',
  "-apple-system",
  "BlinkMacSystemFont",
  '"Segoe UI Variable Text"',
  '"Segoe UI"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"Noto Sans SC"',
  "Roboto",
  "sans-serif",
].join(", ");

const FONT_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export function buildAntdTheme(isDark: boolean): ThemeConfig {
  if (isDark) {
    return {
      algorithm: antdTheme.darkAlgorithm,
      cssVar: true,
      token: {
        colorPrimary: "#34d399",
        colorSuccess: "#4ade80",
        colorWarning: "#fbbf24",
        colorError: "#ff7875",
        colorInfo: "#60a5fa",
        colorLink: "#34d399",

        colorTextBase: "#ecf0ef",
        colorBgBase: "#0d0e0e",
        colorBgContainer: "#161717",
        colorBgElevated: "#161717",
        colorBorder: "#292a2a",
        colorBorderSecondary: "#232424",
        colorSplit: "#232424",
        colorTextSecondary: "#b3b6b5",
        colorTextTertiary: "#9a9d9c",
        colorTextQuaternary: "#494c4b",
        colorFillSecondary: "#1b1c1c",
        colorFillTertiary: "#161717",
        colorFillQuaternary: "#121313",

        fontFamily: FONT_SANS,
        fontFamilyCode: FONT_MONO,
        fontSize: 14,

        borderRadius: 8,
        borderRadiusXS: 4,
        borderRadiusSM: 6,
        borderRadiusLG: 14,
        controlHeight: 34,
        controlHeightSM: 28,
        controlHeightLG: 40,
        controlOutline: "rgba(16, 185, 129, 0.24)",
        controlOutlineWidth: 3,

        wireframe: false,
        motionDurationFast: "0.12s",
        motionDurationMid: "0.16s",
        motionDurationSlow: "0.24s",

        boxShadowTertiary: "0 1px 2px rgba(0, 0, 0, 0.4)",
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.55), 0 1px 2px rgba(0, 0, 0, 0.4)",
        boxShadowSecondary: "0 16px 40px rgba(0, 0, 0, 0.7), 0 3px 10px rgba(0, 0, 0, 0.5)",
      },
      components: {
        Button: {
          primaryShadow: "none",
          defaultShadow: "none",
          dangerShadow: "none",
          fontWeight: 500,
          defaultBg: "#161717",
          defaultBorderColor: "#292a2a",
          defaultColor: "#ecf0ef",
        },
        Select: {
          // Selected = the app's accent-soft selection language (same tint as the
          // active sidebar row / AskPanel option rows); hover stays neutral, so
          // "what is selected" and "what is under the cursor" never look alike.
          optionSelectedBg: "#12271f",
          optionSelectedColor: "#34d399",
          optionActiveBg: "#1b1c1c",
          optionSelectedFontWeight: 500,
          optionHeight: 30,
          optionPadding: "4px 10px",
        },
        Modal: {
          borderRadiusLG: 16,
          titleFontSize: 15,
          headerBg: "transparent",
          contentBg: "#161717",
          footerBg: "transparent",
        },
        Segmented: {
          itemSelectedBg: "#232424",
          itemSelectedColor: "#f7f9f8",
          trackBg: "#121313",
          itemColor: "#b3b6b5",
          itemHoverColor: "#f7f9f8",
          borderRadius: 10,
          trackPadding: 2,
        },
        Tooltip: {
          colorBgSpotlight: "#f7f9f8",
          colorTextLightSolid: "#0d0e0e",
          borderRadius: 8,
          fontSize: 12,
        },
        Dropdown: { borderRadiusLG: 12, paddingBlock: 6 },
        Collapse: {
          headerPadding: 0,
          contentPadding: 0,
          headerBg: "transparent",
          contentBg: "transparent",
          // Rows are rounded to --radius-sm; without this antd's own
          // `0 0 borderRadiusLG borderRadiusLG` header rule overshoots.
          borderRadiusLG: 8,
        },
        Tag: { defaultBg: "#161717", defaultColor: "#b3b6b5", borderRadiusSM: 6 },
        Input: { activeShadow: "0 0 0 3px rgba(16, 185, 129, 0.24)" },
        Message: { borderRadiusLG: 10, contentPadding: "10px 14px" },
        Progress: { defaultColor: "#34d399" },
      },
    };
  }

  return {
    algorithm: antdTheme.defaultAlgorithm,
    cssVar: true,
    token: {
      colorPrimary: "#059669",
      colorSuccess: "#12b76a",
      colorWarning: "#f79009",
      colorError: "#d92d20",
      colorInfo: "#2e90fa",
      colorLink: "#047857",

      colorTextBase: "#1b1d1c",
      colorBgBase: "#ffffff",
      colorBgContainer: "#ffffff",
      colorBgElevated: "#ffffff",
      colorBorder: "#e3e4e3",
      colorBorderSecondary: "#e9eaea",
      colorSplit: "#e9eaea",
      colorTextSecondary: "#565a59",
      colorTextTertiary: "#6b6f6e",
      colorTextQuaternary: "#b2b5b4",
      colorFillSecondary: "#f0f1f0",
      colorFillTertiary: "#f6f7f6",
      colorFillQuaternary: "#fbfbfa",

      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,

      borderRadius: 8,
      borderRadiusXS: 4,
      borderRadiusSM: 6,
      borderRadiusLG: 14,
      controlHeight: 34,
      controlHeightSM: 28,
      controlHeightLG: 40,
      controlOutline: "rgba(5, 150, 105, 0.16)",
      controlOutlineWidth: 3,

      wireframe: false,
      motionDurationFast: "0.12s",
      motionDurationMid: "0.16s",
      motionDurationSlow: "0.24s",

      boxShadowTertiary: "0 1px 2px rgba(16, 24, 40, 0.05)",
      boxShadow: "0 4px 14px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.05)",
      boxShadowSecondary:
        "0 16px 40px rgba(16, 24, 40, 0.14), 0 3px 10px rgba(16, 24, 40, 0.06)",
    },
    components: {
      Button: {
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        fontWeight: 500,
        defaultBg: "#ffffff",
        defaultBorderColor: "#e3e4e3",
        defaultColor: "#1b1d1c",
      },
      Select: {
        // Selected = the app's accent-soft selection language (same tint as the
        // active sidebar row / AskPanel option rows); hover stays neutral, so
        // "what is selected" and "what is under the cursor" never look alike.
        optionSelectedBg: "#e6f6ef",
        optionSelectedColor: "#047857",
        optionActiveBg: "#f0f1f0",
        optionSelectedFontWeight: 500,
        optionHeight: 30,
        optionPadding: "4px 10px",
      },
      Modal: {
        borderRadiusLG: 16,
        titleFontSize: 15,
        headerBg: "transparent",
        contentBg: "#ffffff",
        footerBg: "transparent",
      },
      Segmented: {
        itemSelectedBg: "#ffffff",
        itemSelectedColor: "#0f1110",
        trackBg: "#f6f7f6",
        itemColor: "#565a59",
        itemHoverColor: "#1b1d1c",
        borderRadius: 10,
        trackPadding: 2,
      },
      Tooltip: {
        colorBgSpotlight: "#1b1d1c",
        colorTextLightSolid: "#ffffff",
        borderRadius: 8,
        fontSize: 12,
      },
      Dropdown: { borderRadiusLG: 12, paddingBlock: 6 },
      Collapse: {
        headerPadding: 0,
        contentPadding: 0,
        headerBg: "transparent",
        contentBg: "transparent",
        // Rows are rounded to --radius-sm; without this antd's own
        // `0 0 borderRadiusLG borderRadiusLG` header rule overshoots.
        borderRadiusLG: 8,
      },
      Tag: { defaultBg: "#f6f7f6", defaultColor: "#565a59", borderRadiusSM: 6 },
      Input: { activeShadow: "0 0 0 3px rgba(5, 150, 105, 0.16)" },
      Message: { borderRadiusLG: 10, contentPadding: "10px 14px" },
      Progress: { defaultColor: "#059669" },
    },
  };
}