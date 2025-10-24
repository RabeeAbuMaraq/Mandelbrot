// Web Worker for CPU-based Mandelbrot rendering
// This provides multi-threaded CPU fallback when WebGL precision is insufficient

// Complex number operations
function complexSquare(zr, zi) {
    return [zr * zr - zi * zi, 2 * zr * zi];
}

function complexMagnitude(zr, zi) {
    return Math.sqrt(zr * zr + zi * zi);
}

// Smooth iteration count
function getSmoothIteration(zr, zi, iterations, maxIterations) {
    if (iterations >= maxIterations - 1) {
        return iterations;
    }
    
    const modulus = complexMagnitude(zr, zi);
    const nu = Math.log2(Math.log2(modulus));
    return iterations + 1 - nu;
}

// Color palettes matching the GPU shader
function getColor(t, colorScheme) {
    t = Math.max(0, Math.min(1, t));
    
    let r, g, b;
    
    switch(colorScheme) {
        case 0: // Classic
            r = 0.5 + 0.5 * Math.cos(6.28318 * (t + 0.0));
            g = 0.5 + 0.5 * Math.cos(6.28318 * (t + 0.1));
            b = 0.5 + 0.5 * Math.cos(6.28318 * (t + 0.2));
            break;
            
        case 1: // Fire
            t = (t * 3) % 1;
            if (t < 0.33) {
                r = t * 3 * 0.8;
                g = 0;
                b = 0;
            } else if (t < 0.66) {
                const p = (t - 0.33) * 3;
                r = 0.8 + 0.2 * p;
                g = 0.8 * p;
                b = 0;
            } else {
                const p = (t - 0.66) * 3;
                r = 1.0;
                g = 0.8 + 0.2 * p;
                b = 0.8 * p;
            }
            break;
            
        case 2: // Ocean
            r = 0.0;
            g = 0.07 + 0.43 * t;
            b = 0.15 + 0.65 * t;
            break;
            
        case 3: // Psychedelic
            r = 0.5 + 0.5 * Math.cos(6.28318 * t * 3);
            g = 0.5 + 0.5 * Math.cos(6.28318 * (t * 3 + 0.33));
            b = 0.5 + 0.5 * Math.cos(6.28318 * (t * 3 + 0.67));
            break;
            
        case 4: // Monochrome
            r = g = b = t;
            break;
            
        default: // Ultra smooth
            let color = [0, 0, 0];
            let freq = 1;
            let amp = 1;
            
            for (let i = 0; i < 4; i++) {
                const phase = i * 0.1;
                color[0] += amp * (0.5 + 0.5 * Math.cos(6.28318 * freq * (t + phase)));
                color[1] += amp * (0.5 + 0.5 * Math.cos(6.28318 * freq * (t + 0.1 + phase)));
                color[2] += amp * (0.5 + 0.5 * Math.cos(6.28318 * freq * (1.5 * t + 0.2 + phase)));
                
                freq *= 2;
                amp *= 0.5;
            }
            
            r = color[0] / 1.875;
            g = color[1] / 1.875;
            b = color[2] / 1.875;
            break;
    }
    
    return [
        Math.floor(r * 255),
        Math.floor(g * 255),
        Math.floor(b * 255)
    ];
}

// Mandelbrot calculation with optimizations
function calculateMandelbrot(params) {
    const {
        startX, endX, startY, endY,
        width, height,
        centerX, centerY, zoom,
        maxIterations, colorScheme,
        smoothing, antialiasing
    } = params;
    
    const imageData = new Uint8ClampedArray(width * height * 4);
    const samples = antialiasing ? 4 : 1;
    const sampleOffsets = antialiasing ? 
        [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]] :
        [[0, 0]];
    
    for (let py = startY; py < endY; py++) {
        for (let px = startX; px < endX; px++) {
            let totalR = 0, totalG = 0, totalB = 0;
            
            for (let sample = 0; sample < samples; sample++) {
                const [ox, oy] = sampleOffsets[sample];
                
                // Convert pixel to complex coordinates
                const x = (px + ox - width / 2) / (zoom * width / 4) + centerX;
                const y = -(py + oy - height / 2) / (zoom * height / 4) + centerY;
                
                // Cardioid optimization
                const q = (x - 0.25) * (x - 0.25) + y * y;
                if (q * (q + (x - 0.25)) <= 0.25 * y * y) {
                    continue;
                }
                
                // Period-2 bulb optimization
                if ((x + 1) * (x + 1) + y * y <= 0.0625) {
                    continue;
                }
                
                // Mandelbrot iteration
                let zr = 0, zi = 0;
                let iterations = 0;
                
                for (let i = 0; i < maxIterations; i++) {
                    const [newZr, newZi] = complexSquare(zr, zi);
                    zr = newZr + x;
                    zi = newZi + y;
                    
                    const magnitude = zr * zr + zi * zi;
                    if (magnitude > 256) {
                        iterations = i;
                        break;
                    }
                    
                    iterations = i + 1;
                }
                
                // Color calculation
                if (iterations < maxIterations) {
                    const smoothIter = smoothing ? 
                        getSmoothIteration(zr, zi, iterations, maxIterations) :
                        iterations;
                    
                    const normalized = smoothIter / maxIterations;
                    const [r, g, b] = getColor(normalized, colorScheme);
                    
                    totalR += r;
                    totalG += g;
                    totalB += b;
                }
            }
            
            // Average samples
            const idx = (py * width + px) * 4;
            imageData[idx] = totalR / samples;
            imageData[idx + 1] = totalG / samples;
            imageData[idx + 2] = totalB / samples;
            imageData[idx + 3] = 255;
        }
        
        // Report progress
        if ((py - startY) % 10 === 0) {
            self.postMessage({
                type: 'progress',
                progress: (py - startY) / (endY - startY)
            });
        }
    }
    
    return imageData;
}

// Message handler
self.onmessage = function(e) {
    const { type, params } = e.data;
    
    if (type === 'calculate') {
        const imageData = calculateMandelbrot(params);
        
        self.postMessage({
            type: 'result',
            imageData: imageData,
            startX: params.startX,
            endX: params.endX,
            startY: params.startY,
            endY: params.endY
        }, [imageData.buffer]);
    }
};