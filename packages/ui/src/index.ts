/**
 * @polaris/ui: the Polaris component library. See README.md for every
 * component with a usage line, and /gallery in either app to see them.
 */

// Helpers
export { cn } from "./lib/cn";
export { formatMoney, formatPercent, formatCompact, moneyParts, currencySymbol, groupTyped } from "./lib/format";
export { useMediaQuery, useControllable, useScrollLock, useFocusTrap, useReducedMotionSafe, SHEET_QUERY } from "./lib/hooks";
export { IconSlot, IconProvider, ICON_STROKE } from "./lib/icon";

// Primitives
export { Button, IconButton, pressable } from "./primitives/Button";
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps, IconButtonTone } from "./primitives/Button";
export { Pill, Chip, DeltaBadge, Badge } from "./primitives/Pill";
export type { PillProps, PillTone, ChipProps, DeltaBadgeProps, BadgeProps, BadgeTone } from "./primitives/Pill";
export { Avatar, AvatarStack, FlagBadge, pastelFor, initials, PASTEL_BG } from "./primitives/Avatar";
export type { AvatarProps, AvatarStackProps, FlagBadgeProps, FlagCode, Pastel } from "./primitives/Avatar";
export { Card, Tile, SectionHeader, ThemeScope, RowChevron } from "./primitives/Card";
export type { CardProps, TileProps, SectionHeaderProps, ThemeScopeProps, Theme } from "./primitives/Card";
export { SegmentedControl, RangeTabs, Tabs, TabList, Tab, TabPanel } from "./primitives/Segmented";
export type { SegmentedControlProps, SegmentOption, RangeTabsProps, TabsProps, TabProps } from "./primitives/Segmented";
export { Money } from "./primitives/Money";
export type { MoneyProps } from "./primitives/Money";
export { Input, Textarea, Select, Toggle } from "./primitives/Field";
export type { InputProps, TextareaProps, SelectProps, SelectOption, ToggleProps } from "./primitives/Field";
export { Skeleton, SkeletonText, EmptyState, IconDisc } from "./primitives/Feedback";
export type { SkeletonProps, EmptyStateProps, IconDiscProps } from "./primitives/Feedback";
export { Toaster, toast } from "./primitives/Toast";
export type { ToastInput, ToastTone } from "./primitives/Toast";
export { Table, CellStack } from "./primitives/Table";
export type { TableProps, TableColumn, SortState } from "./primitives/Table";
export { Logo, LogoMark } from "./primitives/Logo";
export { Keypad, AmountDisplay, applyKey } from "./primitives/Keypad";
export { Notice, ErrorState } from "./primitives/Notice";
export type { NoticeProps, NoticeTone, ErrorStateProps } from "./primitives/Notice";
export { Ticks } from "./primitives/Ticks";
export type { TicksProps } from "./primitives/Ticks";
export { CopyButton } from "./primitives/CopyButton";
export type { CopyButtonProps } from "./primitives/CopyButton";
export { Menu } from "./primitives/Menu";
export type { MenuProps, MenuItemProps } from "./primitives/Menu";
export type { KeypadProps, KeypadKey, AmountDisplayProps } from "./primitives/Keypad";
export { SuccessCheck } from "./primitives/SuccessCheck";
export type { SuccessCheckProps } from "./primitives/SuccessCheck";
export { PageDots } from "./primitives/PageDots";
export type { PageDotsProps } from "./primitives/PageDots";
export { ScanFrame } from "./primitives/ScanFrame";
export type { ScanFrameProps } from "./primitives/ScanFrame";
export { TxLink, shortHash } from "./primitives/TxLink";
export type { TxLinkProps } from "./primitives/TxLink";
export { ProvenanceBadge } from "./primitives/Provenance";
export type { ProvenanceBadgeProps } from "./primitives/Provenance";
export { Meter } from "./primitives/Meter";
export type { MeterProps, MeterTone } from "./primitives/Meter";

// Composites
export { StatCard } from "./composites/StatCard";
export type { StatCardProps, StatCardTone } from "./composites/StatCard";
export { StatTile, KeyValueGrid, DetailsList } from "./composites/Stats";
export type { StatTileProps, KeyValueGridProps, DetailsListProps, KeyValue } from "./composites/Stats";
export { TxRow } from "./composites/TxRow";
export type { TxRowProps } from "./composites/TxRow";
export { CardStack } from "./composites/CardStack";
export type { CardStackProps, CardStackAction } from "./composites/CardStack";
export { GradientCard } from "./composites/GradientCard";
export type { GradientCardProps, GradientTone } from "./composites/GradientCard";
export { BalanceCard, ActionRow } from "./composites/BalanceCard";
export type { BalanceCardProps, ActionRowProps, Action } from "./composites/BalanceCard";
export { QuickTransfer, AssetRow, FeaturedTile, TileButton } from "./composites/Rows";
export type { QuickTransferProps, AssetRowProps, FeaturedTileProps, TileButtonProps } from "./composites/Rows";
export { MiniCardCarousel, MINI_CARD_TINTS } from "./composites/MiniCardCarousel";
export type { MiniCardCarouselProps, MiniCard } from "./composites/MiniCardCarousel";
export { BottomNav, AppHeader, ScreenHeader } from "./composites/Navigation";
export { ListRow, ListGroup } from "./composites/ListRow";
export type { ListRowProps, ListGroupProps } from "./composites/ListRow";
export type { BottomNavProps, NavItem, AppHeaderProps, ScreenHeaderProps } from "./composites/Navigation";
export { SideNav } from "./composites/SideNav";
export type { SideNavProps, SideNavItem } from "./composites/SideNav";
export { PageHeader } from "./composites/PageHeader";
export type { PageHeaderProps } from "./composites/PageHeader";
export { CodeBlock } from "./composites/CodeBlock";
export type { CodeBlockProps, CodeSample } from "./composites/CodeBlock";
export { PhoneFrame } from "./composites/PhoneFrame";
export type { PhoneFrameProps } from "./composites/PhoneFrame";
export { CheckList } from "./composites/CheckList";
export type { CheckListProps, CheckItem } from "./composites/CheckList";

// Charts
export { Sparkline } from "./charts/Sparkline";
export type { SparklineProps } from "./charts/Sparkline";
export { LineArea } from "./charts/LineArea";
export type { LineAreaProps, LinePoint } from "./charts/LineArea";
export { CandlestickChart } from "./charts/CandlestickChart";
export type { CandlestickChartProps, Candle } from "./charts/CandlestickChart";
export { DonutChart } from "./charts/DonutChart";
export type { DonutChartProps, DonutSegment } from "./charts/DonutChart";
export { BarChart, BAR_COLORS } from "./charts/BarChart";
export type { BarChartProps, Bar } from "./charts/BarChart";
export { HBarList, HBAR_COLORS } from "./charts/HBarList";
export type { HBarListProps, HBar } from "./charts/HBarList";
export { ProgressLegend } from "./charts/ProgressLegend";
export type { ProgressLegendProps, LegendItem } from "./charts/ProgressLegend";

// Presentation
export { BottomSheet, SheetStage, Sheet } from "./overlays/BottomSheet";
export type { BottomSheetProps, SheetStageProps, SnapPoint } from "./overlays/BottomSheet";
export { Drawer, Dialog } from "./overlays/Panels";
export type { DrawerProps, DialogProps } from "./overlays/Panels";
export { useOverlay } from "./overlays/parts";
export type { OverlayHeaderProps } from "./overlays/parts";

// Ref E (LumaTrade): the merchant web app's frame, nav, chart and trade widget
export { AppFrame } from "./trade/AppFrame";
export type { AppFrameProps } from "./trade/AppFrame";
export { TopNav, NavLink, NavDropdown, WalletPill } from "./trade/TopNav";
export type { TopNavProps, TopNavItem, NavLinkProps, NavDropdownProps, WalletPillProps } from "./trade/TopNav";
export { PrimaryButton, SecondaryButton, IconSquareButton } from "./trade/Buttons";
export type { TradeButtonProps, TradeButtonSize, IconSquareButtonProps } from "./trade/Buttons";
export { DeltaChip, StatusPill, TimeframeChips, ChartTypeToggle, TextTabs } from "./trade/Chips";
export type { DeltaChipProps, StatusPillProps, StatusPillTone, TimeframeChipsProps, ChartType, ChartTypeToggleProps, TextTabsProps } from "./trade/Chips";
export { PairHeader, Coin, CoinPair, PolarisCoin, DollarCoin } from "./trade/PairHeader";
export type { PairHeaderProps, PairOption, CoinProps, CoinTone, CoinPairProps } from "./trade/PairHeader";
export { GradientLineChart } from "./trade/GradientLineChart";
export { compactNumber, compactTickLabels, spanTicks, tickDecimals } from "./charts/ticks";
export type { GradientLineChartProps, GradientPoint } from "./trade/GradientLineChart";
export { DataTable, TableName } from "./trade/DataTable";
export type { DataTableProps } from "./trade/DataTable";
export { SwapCard, SwapToggle, SwapStack } from "./trade/Swap";
export type { SwapCardProps, SwapToggleProps, SwapStackProps } from "./trade/Swap";
export { BalanceSummaryCard } from "./trade/BalanceSummaryCard";
export type { BalanceSummaryCardProps, BalanceStat } from "./trade/BalanceSummaryCard";
export { PanelCard } from "./trade/PanelCard";
export type { PanelCardProps } from "./trade/PanelCard";
export { FigureRow } from "./trade/FigureRow";
export type { FigureRowProps } from "./trade/FigureRow";
export { RunList } from "./trade/RunList";
export type { RunListProps, RunItem } from "./trade/RunList";

// One route, two layouts: the phone's below 1024px, ref E's desktop from 1024px
export { Adaptive, useAdaptive, useIsDesktop, DESKTOP_QUERY } from "./trade/Adaptive";
export type { AdaptiveProps, AdaptiveMode } from "./trade/Adaptive";
export { AdaptiveSheet } from "./overlays/AdaptiveSheet";
export type { AdaptiveSheetProps } from "./overlays/AdaptiveSheet";
