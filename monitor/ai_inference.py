# monitor/ai_inference.py
import numpy as np
try:
    from tflite_runtime.interpreter import Interpreter
except ImportError:
    print("tflite_runtime not found. Please install it in your virtual environment.")

def load_tflite_model(model_path="placeholder_model.tflite"):
    """
    Loads a TFLite model and allocates tensors.
    Replace "placeholder_model.tflite" with your actual model file.
    """
    interpreter = Interpreter(model_path=model_path)
    interpreter.allocate_tensors()
    return interpreter

def run_inference(interpreter, input_value):
    """
    Runs inference on the given input value.
    This example assumes the model expects a 2D array of shape [1, 1].
    """
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    # Prepare input data; adjust shape as necessary for your model.
    input_data = np.array([[input_value]], dtype=np.float32)
    interpreter.set_tensor(input_details[0]['index'], input_data)
    interpreter.invoke()
    output_data = interpreter.get_tensor(output_details[0]['index'])
    return output_data

if __name__ == "__main__":
    # Quick test: load the model and run inference with a test value.
    interpreter = load_tflite_model("placeholder_model.tflite")
    result = run_inference(interpreter, 25.0)
    print("Inference result:", result)
