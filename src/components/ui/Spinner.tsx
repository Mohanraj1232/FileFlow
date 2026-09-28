export function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div
      className="animate-spin rounded-full border-[3px] border-accent border-t-transparent"
      style={{ width: size, height: size }}
    />
  );
}

export function LoadingState({ height = "h-64" }: { height?: string }) {
  return (
    <div className={`flex items-center justify-center ${height}`}>
      <Spinner />
    </div>
  );
}
