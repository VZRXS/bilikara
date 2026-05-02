from PIL import ImageFont
try:
    font = ImageFont.truetype("static/fonts/SourceHanSans-VF.ttf", 24)
    if hasattr(font, "get_variation_axes"):
        print("Axes:", font.get_variation_axes())
    if hasattr(font, "set_variation_by_axes"):
        print("Setting wght to 700")
        font.set_variation_by_axes([700])
    elif hasattr(font, "set_variation_by_name"):
        print("Setting variation by name")
except Exception as e:
    print("Error:", e)
