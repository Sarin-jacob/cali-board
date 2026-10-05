# OpenCV.js export whitelist for CaliBoard.
#
# Starts from OpenCV's stock platforms/js/opencv_js.config.py and adds the calibration API that the
# stock build leaves out. Pass it to build_js.py with --config (see build.sh).
#
# The first block reproduces what the currently bundled public/opencv/opencv4.13.js exports
# (verified by enumerating that build). The second block lists functions CaliBoard would use if
# available; build_js.py silently skips names that fail to bind, so they are safe to request.
import os

_stock = os.path.join(os.environ.get('OPENCV_SRC', '/work/opencv'), 'platforms', 'js', 'opencv_js.config.py')
exec(open(_stock).read())  # defines core, imgproc, objdetect, video, dnn, features2d, photo, calib3d, white_list

calib3d[''] += [
    # --- present in the current CaliBoard build ---
    'calibrateCamera',
    'findChessboardCorners',
    'findChessboardCornersSB',
    'drawChessboardCorners',
    'getOptimalNewCameraMatrix',
    'stereoCalibrate',
    'stereoRectify',
    'stereoRectifyUncalibrated',
    'computeCorrespondEpilines',
    'findEssentialMat',
    'findFundamentalMat',
    'recoverPose',
    'triangulatePoints',
    'reprojectImageTo3D',
    'estimateAffine3D',
    'fisheye_calibrate',
    'fisheye_undistortImage',
    'fisheye_estimateNewCameraMatrixForUndistortRectify',
    'fisheye_stereoCalibrate',
    'fisheye_stereoRectify',

    # --- wanted next (missing from the current build) ---
    'findCirclesGrid',          # symmetric / asymmetric circle-grid targets
    'calibrateHandEye',         # robot hand-eye calibration
    'calibrateRobotWorldHandEye',
    'undistortPoints',          # point undistortion without remapping images
    'undistortImagePoints',
    'fisheye_undistortPoints',
    'calibrationMatrixValues',  # FOV / focal length in mm from sensor size
    'solvePnPGeneric',
    'decomposeHomographyMat',
]
calib3d['StereoBM'] = ['create', 'compute', 'setPreFilterCap', 'setUniquenessRatio', 'setTextureThreshold', 'setSpeckleRange', 'setSpeckleWindowSize', 'setNumDisparities', 'setBlockSize']
calib3d['StereoSGBM'] = ['create', 'compute', 'setP1', 'setP2', 'setMode', 'setNumDisparities', 'setBlockSize', 'setUniquenessRatio', 'setSpeckleRange', 'setSpeckleWindowSize', 'setDisp12MaxDiff', 'setPreFilterCap']

if 'cornerSubPix' not in imgproc['']:
    imgproc[''].append('cornerSubPix')

white_list = makeWhiteList([core, imgproc, objdetect, video, dnn, features2d, photo, calib3d])
