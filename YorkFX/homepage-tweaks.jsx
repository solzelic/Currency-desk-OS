// YorkFX Homepage — Tweaks
// Colour is the default (plain CSS). These toggles switch back to strict B&W.
const { useEffect } = React;

function YorkTweaks() {
  const [tw, setTweak] = useTweaks({
    colorDeltas: true,   // green/red up-down on the rate board
    colorImages: true,   // photography in full colour
  });

  useEffect(() => {
    document.body.classList.toggle('tw-bw-deltas', !tw.colorDeltas);
    document.body.classList.toggle('tw-bw-images', !tw.colorImages);
  }, [tw.colorDeltas, tw.colorImages]);

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection title="Colour">
        <TweakToggle
          label="Green / red rate changes"
          value={!!tw.colorDeltas}
          onChange={(v) => setTweak('colorDeltas', v)}
        />
        <TweakToggle
          label="Colour photography"
          value={!!tw.colorImages}
          onChange={(v) => setTweak('colorImages', v)}
        />
      </TweakSection>
    </TweaksPanel>
  );
}

const yorkTweaksRoot = document.createElement('div');
document.body.appendChild(yorkTweaksRoot);
ReactDOM.createRoot(yorkTweaksRoot).render(<YorkTweaks />);
